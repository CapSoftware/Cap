import { useQueryClient } from "@tanstack/solid-query";
import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { devicesSnapshot } from "~/utils/devices";
import { requestAndVerifyPermission } from "~/utils/os-permissions";
import { commands, type OSPermissionStatus } from "~/utils/tauri";

type SettingsHandoff = { revision: number; wasUnfocused: boolean };

let permissionWindow: PermissionWindow | undefined;
let windowLevelUpdate = Promise.resolve();

class PermissionWindow {
	private pending = 0;
	private disposed = false;
	private revision = 0;
	private focused: boolean | undefined;
	private lastBlur = -1;
	private lastFocus = -1;
	private settingsHandoff: SettingsHandoff | undefined;
	private unlisten: UnlistenFn[] = [];
	private restoring: Promise<void> | undefined;
	private ready: Promise<void>;

	constructor(
		private window: Window,
		private refreshDevices: () => Promise<unknown>,
	) {
		this.ready = this.listen();
	}

	private current() {
		return !this.disposed && permissionWindow === this;
	}

	private dispose() {
		this.disposed = true;
		if (permissionWindow === this) permissionWindow = undefined;
		for (const unlisten of this.unlisten.splice(0)) unlisten();
	}

	private addListener(unlisten: UnlistenFn) {
		if (this.disposed) unlisten();
		else this.unlisten.push(unlisten);
	}

	private async listen() {
		this.addListener(
			await this.window.once(TauriEvent.WINDOW_DESTROYED, () => this.dispose()),
		);
		if (this.disposed) return;
		this.addListener(
			await this.window.onFocusChanged(({ payload: focused }) => {
				this.revision += 1;
				this.focused = focused;
				if (focused) this.lastFocus = this.revision;
				else this.lastBlur = this.revision;
				void this.restore().catch((error) => {
					console.error("Failed to restore permission window:", error);
				});
			}),
		);
		if (this.disposed) return;
		const revision = this.revision;
		const focused = await this.window.isFocused();
		if (this.revision === revision) this.focused = focused;
	}

	private canRestore() {
		return (
			this.current() &&
			this.pending === 0 &&
			(this.settingsHandoff === undefined ||
				(this.lastFocus > this.settingsHandoff.revision &&
					(this.settingsHandoff.wasUnfocused ||
						this.lastBlur > this.settingsHandoff.revision) &&
					this.lastFocus > this.lastBlur))
		);
	}

	private setAlwaysOnTop(value: boolean) {
		const update = windowLevelUpdate.then(async () => {
			if (!this.current() || (value && !this.canRestore())) return;
			await this.window.setAlwaysOnTop(value);
		});
		windowLevelUpdate = update.catch(() => {});
		return update;
	}

	async acquire() {
		this.pending += 1;
		try {
			await this.ready;
			await this.setAlwaysOnTop(false);
			if (!this.current()) throw new Error("Permission window was closed");
		} catch (error) {
			this.pending -= 1;
			this.dispose();
			throw error;
		}
	}

	beginSettingsHandoff(): SettingsHandoff {
		return { revision: this.revision, wasUnfocused: this.focused === false };
	}

	async release(settingsHandoff: SettingsHandoff | undefined) {
		this.pending -= 1;
		if (
			settingsHandoff !== undefined &&
			settingsHandoff.revision >= (this.settingsHandoff?.revision ?? -1)
		) {
			this.settingsHandoff = settingsHandoff;
		}
		await this.restore();
	}

	private async restore() {
		if (!this.canRestore()) return;
		if (this.restoring) return this.restoring;
		this.restoring = this.setAlwaysOnTop(true)
			.then(async () => {
				if (!this.canRestore()) return;
				const returnedFromSettings = this.settingsHandoff !== undefined;
				this.dispose();
				if (returnedFromSettings) await this.refreshDevices();
			})
			.finally(() => {
				this.restoring = undefined;
			});
		return this.restoring;
	}
}

export default function useRequestPermission() {
	const queryClient = useQueryClient();
	const refreshDevices = () =>
		queryClient.fetchQuery({ ...devicesSnapshot, staleTime: 0 });

	async function requestPermission(
		type: "camera" | "microphone",
		currentStatus?: OSPermissionStatus,
	) {
		try {
			const window = getCurrentWindow();
			if (ostype() === "macos") {
				permissionWindow ??= new PermissionWindow(window, refreshDevices);
				const session = permissionWindow;
				await session.acquire();
				let settingsHandoff: SettingsHandoff | undefined;
				try {
					const result = await requestAndVerifyPermission(
						{
							requestPermission: commands.requestPermission,
							doPermissionsCheck: commands.doPermissionsCheck,
							openPermissionSettings: async (permission) => {
								const handoff = session.beginSettingsHandoff();
								await commands.openPermissionSettings(permission);
								settingsHandoff = handoff;
							},
						},
						type,
						currentStatus,
					);
					if (!result.openedSettings) settingsHandoff = undefined;
				} finally {
					await session.release(settingsHandoff);
				}
			} else {
				await window.setAlwaysOnTop(false);
				try {
					await requestAndVerifyPermission(commands, type, currentStatus);
				} finally {
					await window.setAlwaysOnTop(true);
				}
			}
			await refreshDevices();
		} catch (error) {
			console.error(`Failed to get ${type} permission:`, error);
		}
	}

	return requestPermission;
}
