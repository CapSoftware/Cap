import { execFileSync } from "node:child_process";

interface RaycastRuntimeModule {
	Clipboard: {
		readText: () => Promise<string | undefined>;
		copy: (text: string) => Promise<void>;
	};
	closeMainWindow: () => Promise<void>;
	getPreferenceValues: <T>() => T;
	open: (target: string) => Promise<void>;
	showHUD: (title: string) => Promise<void>;
}

let cachedRuntime: RaycastRuntimeModule | null | undefined;

async function loadRaycastRuntime(): Promise<RaycastRuntimeModule | null> {
	if (cachedRuntime !== undefined) {
		return cachedRuntime;
	}
	try {
		const moduleName = "@raycast/api";
		cachedRuntime = (await import(moduleName)) as RaycastRuntimeModule;
		return cachedRuntime;
	} catch {
		cachedRuntime = null;
		return null;
	}
}

export async function getPreferenceValues<T extends object>(): Promise<T> {
	const runtime = await loadRaycastRuntime();
	if (runtime) {
		return runtime.getPreferenceValues<T>();
	}
	return {} as T;
}

export async function closeMainWindow(): Promise<void> {
	const runtime = await loadRaycastRuntime();
	if (runtime) {
		await runtime.closeMainWindow();
	}
}

export async function open(target: string): Promise<void> {
	const runtime = await loadRaycastRuntime();
	if (runtime) {
		await runtime.open(target);
		return;
	}
	execFileSync("open", [target]);
}

export async function showHUD(title: string): Promise<void> {
	const runtime = await loadRaycastRuntime();
	if (runtime) {
		await runtime.showHUD(title);
	}
}

export const Clipboard = {
	async readText(): Promise<string | undefined> {
		const runtime = await loadRaycastRuntime();
		if (runtime) {
			return runtime.Clipboard.readText();
		}
		try {
			return execFileSync("pbpaste", { encoding: "utf8" });
		} catch {
			return undefined;
		}
	},
	async copy(text: string): Promise<void> {
		const runtime = await loadRaycastRuntime();
		if (runtime) {
			await runtime.Clipboard.copy(text);
			return;
		}
		execFileSync("pbcopy", { input: text, encoding: "utf8" });
	},
};
