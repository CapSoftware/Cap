import { Button } from "@cap/ui-solid";
import { createWritableMemo } from "@solid-primitives/memo";
import {
	isPermissionGranted,
	requestPermission,
} from "@tauri-apps/plugin-notification";
import { type OsType, type } from "@tauri-apps/plugin-os";
import "@total-typescript/ts-reset/filter-boolean";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import { createEffect, createMemo, createResource, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { Input } from "~/routes/editor/ui";
import { authStore, generalSettingsStore } from "~/store";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";
import {
	type AppTheme,
	type CaptureWindowWithThumbnail,
	commands,
	type GeneralSettingsStore,
	type WindowExclusion,
	type MainWindowRecordingStartBehaviour,
	type PostDeletionBehaviour,
	type PostStudioRecordingBehaviour,
} from "~/utils/tauri";
import { Setting, ToggleSetting } from "./Setting";

const getExclusionPrimaryLabel = (entry: WindowExclusion) =>
	entry.ownerName ?? entry.windowTitle ?? entry.bundleIdentifier ?? "Unknown";

const getExclusionSecondaryLabel = (entry: WindowExclusion) => {
	if (entry.ownerName && entry.windowTitle) {
		return entry.windowTitle;
	}

	if (entry.bundleIdentifier && (entry.ownerName || entry.windowTitle)) {
		return entry.bundleIdentifier;
	}

	return entry.bundleIdentifier ?? null;
};

const getWindowOptionLabel = (window: CaptureWindowWithThumbnail) => {
	const parts = [window.owner_name];
	if (window.name && window.name !== window.owner_name) {
		parts.push(window.name);
	}
	return parts.join(" • ");
};

type LegacyWindowExclusion = {
	bundle_identifier?: string | null;
	owner_name?: string | null;
	window_title?: string | null;
};

const coerceWindowExclusion = (entry: WindowExclusion | LegacyWindowExclusion): WindowExclusion => {
	if (entry && typeof entry === "object") {
		if ("bundleIdentifier" in entry || "ownerName" in entry || "windowTitle" in entry) {
			const current = entry as WindowExclusion;
			return {
				bundleIdentifier: current.bundleIdentifier ?? null,
				ownerName: current.ownerName ?? null,
				windowTitle: current.windowTitle ?? null,
			};
		}

		const legacy = entry as LegacyWindowExclusion;
		return {
			bundleIdentifier: legacy.bundle_identifier ?? null,
			ownerName: legacy.owner_name ?? null,
			windowTitle: legacy.window_title ?? null,
		};
	}

	return {
		bundleIdentifier: null,
		ownerName: null,
		windowTitle: null,
	};
};

const normalizeWindowExclusions = (
	entries: (WindowExclusion | LegacyWindowExclusion)[],
): WindowExclusion[] =>
	entries.map((entry) => {
		const coerced = coerceWindowExclusion(entry);
		const bundleIdentifier = coerced.bundleIdentifier ?? null;
		const ownerName = coerced.ownerName ?? null;
		const hasBundleIdentifier =
			typeof bundleIdentifier === "string" && bundleIdentifier.length > 0;
		return {
			bundleIdentifier,
			ownerName,
			windowTitle: hasBundleIdentifier ? null : coerced.windowTitle ?? null,
		} satisfies WindowExclusion;
	});

const createDefaultGeneralSettings = (): GeneralSettingsStore => ({
	uploadIndividualFiles: false,
	hideDockIcon: false,
	autoCreateShareableLink: false,
	enableNotifications: true,
	enableNativeCameraPreview: false,
	enableNewRecordingFlow: false,
	autoZoomOnClicks: false,
	custom_cursor_capture2: true,
	enableNewUploader: false,
	excludedWindows: normalizeWindowExclusions([]),
});

const deriveInitialSettings = (
	store: GeneralSettingsStore | null,
): GeneralSettingsStore => {
	const defaults = createDefaultGeneralSettings();
	if (!store) return defaults;

	const { excluded_windows, ...rest } = store as GeneralSettingsStore & {
		excluded_windows?: LegacyWindowExclusion[];
	};

	const rawExcludedWindows = (
		store.excludedWindows ?? excluded_windows ?? []
	) as (WindowExclusion | LegacyWindowExclusion)[];

	return {
		...defaults,
		...rest,
		excludedWindows: normalizeWindowExclusions(rawExcludedWindows),
	};
};

export default function GeneralSettings() {
	const [store] = createResource(generalSettingsStore.get, {
		initialValue: null,
	});

	return (
		<Inner
			initialStore={(store() as GeneralSettingsStore | undefined) ?? null}
			isStoreLoading={store.loading}
		/>
	);
}

function AppearanceSection(props: {
	currentTheme: AppTheme;
	onThemeChange: (theme: AppTheme) => void;
}) {
	const options = [
		{ id: "system", name: "System", preview: themePreviewAuto },
		{ id: "light", name: "Light", preview: themePreviewLight },
		{ id: "dark", name: "Dark", preview: themePreviewDark },
	] satisfies { id: AppTheme; name: string; preview: string }[];

	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-col pb-4 border-b border-gray-2">
				<h2 class="text-lg font-medium text-gray-12">General</h2>
				<p class="text-sm text-gray-10">
					General settings of your Cap application.
				</p>
			</div>
			<div
				class="flex justify-start items-center text-gray-12"
				onContextMenu={(e) => e.preventDefault()}
			>
				<div class="flex flex-col gap-3">
					<p class="text-sm text-gray-12">Appearance</p>
					<div class="flex justify-between m-1 min-w-[20rem] w-[22.2rem] flex-nowrap">
						<For each={options}>
							{(theme) => (
								<button
									type="button"
									aria-checked={props.currentTheme === theme.id}
									class="flex flex-col items-center rounded-md group focus:outline-none focus-visible:ring-gray-300 focus-visible:ring-offset-gray-50 focus-visible:ring-offset-2 focus-visible:ring-4"
									onClick={() => props.onThemeChange(theme.id)}
								>
									<div
										class={cx(
											`w-24 h-[4.8rem] rounded-md overflow-hidden focus:outline-none ring-offset-gray-50 transition-all duration-200`,
											{
												"ring-2 ring-gray-12 ring-offset-2":
													props.currentTheme === theme.id,
												"group-hover:ring-2 ring-offset-2 group-hover:ring-gray-5":
													props.currentTheme !== theme.id,
											},
										)}
										aria-label={`Select theme: ${theme.name}`}
									>
										<div class="flex justify-center items-center w-full h-full">
											<img
												draggable={false}
												src={theme.preview}
												alt={`Preview of ${theme.name} theme`}
											/>
										</div>
									</div>
									<span
										class={cx(`mt-2 text-sm transition-color duration-200`, {
											"text-gray-12": props.currentTheme === theme.id,
											"text-gray-10": props.currentTheme !== theme.id,
										})}
									>
										{theme.name}
									</span>
								</button>
							)}
						</For>
					</div>
				</div>
			</div>
		</div>
	);
}

function Inner(props: {
	initialStore: GeneralSettingsStore | null;
	isStoreLoading: boolean;
}) {
	const [settings, setSettings] = createStore<GeneralSettingsStore>(
		deriveInitialSettings(props.initialStore),
	);

	createEffect(() => {
		setSettings(reconcile(deriveInitialSettings(props.initialStore)));
	});

	const [windows] = createResource(commands.listWindowsWithThumbnails, {
		initialValue: [] as CaptureWindowWithThumbnail[],
	});

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		setSettings(key as keyof GeneralSettingsStore, value);
		generalSettingsStore.set({ [key]: value });
	};

	const ostype: OsType = type();
	const excludedWindows = createMemo(() => settings.excludedWindows ?? []);
	const isExcludedWindowsLoading = createMemo(
		() => props.isStoreLoading || windows.loading,
	);

	const matchesExclusion = (exclusion: WindowExclusion, window: CaptureWindowWithThumbnail) => {
		const bundleMatch = exclusion.bundleIdentifier
			? window.bundle_identifier === exclusion.bundleIdentifier
			: false;
		if (bundleMatch) return true;

		const ownerMatch = exclusion.ownerName
			? window.owner_name === exclusion.ownerName
			: false;

		if (exclusion.ownerName && exclusion.windowTitle) {
			return ownerMatch && window.name === exclusion.windowTitle;
		}

		if (ownerMatch && exclusion.ownerName) {
			return true;
		}

		if (exclusion.windowTitle) {
			return window.name === exclusion.windowTitle;
		}

		return false;
	};

	const isManagedWindowsApp = (window: CaptureWindowWithThumbnail) => {
		const bundle = window.bundle_identifier?.toLowerCase() ?? "";
		if (bundle.includes("so.cap.desktop")) {
			return true;
		}
		return window.owner_name.toLowerCase().includes("cap");
	};

	const availableWindows = createMemo(() => {
		const data = windows() ?? [];
		return data.filter((window) => {
			if (excludedWindows().some((entry) => matchesExclusion(entry, window))) {
				return false;
			}
			if (ostype === "windows") {
				return isManagedWindowsApp(window);
			}
			return true;
		});
	});

	const applyExcludedWindows = async (next: WindowExclusion[]) => {
		const normalized = normalizeWindowExclusions(next);
		setSettings("excludedWindows", normalized);
		try {
			await generalSettingsStore.set({ excludedWindows: normalized });
			await commands.refreshWindowContentProtection();
		} catch (error) {
			console.error("Failed to update excluded windows", error);
		}
	};

	const handleRemoveExclusion = async (index: number) => {
		const current = [...excludedWindows()];
		current.splice(index, 1);
		await applyExcludedWindows(current);
	};

	const handleAddWindow = async (window: CaptureWindowWithThumbnail) => {
		const windowTitle = window.bundle_identifier ? null : window.name;

		const next = [
			...excludedWindows(),
			{
				bundleIdentifier: window.bundle_identifier ?? null,
				ownerName: window.owner_name ?? null,
				windowTitle,
			},
		];
		await applyExcludedWindows(next);
	};

	const handleResetExclusions = async () => {
		const defaults = await commands.getDefaultExcludedWindows();
		await applyExcludedWindows(defaults);
	};

	type ToggleSettingItem = {
		label: string;
		type: "toggle";
		description: string;
		value: boolean;
		onChange: (value: boolean) => void | Promise<void>;
		os?: "macos" | "windows" | "linux";
	};

	type SelectSettingItem = {
		label: string;
		type: "select";
		description: string;
		value:
			| MainWindowRecordingStartBehaviour
			| PostStudioRecordingBehaviour
			| PostDeletionBehaviour
			| number;
		onChange: (
			value:
				| MainWindowRecordingStartBehaviour
				| PostStudioRecordingBehaviour
				| PostDeletionBehaviour
				| number,
		) => void | Promise<void>;
	};

	type SettingItem = ToggleSettingItem | SelectSettingItem;

	type SettingsGroup = {
		title: string;
		os?: "macos" | "windows" | "linux";
		titleStyling?: string;
		items: SettingItem[];
	};

	// Static settings groups structure to preserve component identity
	const settingsGroups: SettingsGroup[] = [
		{
			title: "Cap Pro",
			titleStyling:
				"bg-blue-500 py-1.5 mb-4 text-white text-xs px-2 rounded-lg",
			items: [
				{
					label: "Disable automatic link opening",
					type: "toggle",
					description:
						"When enabled, Cap will not automatically open links in your browser (e.g. after creating a shareable link).",
					get value() {
						return !!settings.disableAutoOpenLinks;
					},
					onChange: (value: boolean) =>
						handleChange("disableAutoOpenLinks", value),
				},
			],
		},
		{
			title: "App",
			os: "macos",
			items: [
				{
					label: "Hide dock icon",
					type: "toggle",
					os: "macos",
					description:
						"The dock icon will be hidden when there are no windows available to close.",
					get value() {
						return !!settings.hideDockIcon;
					},
					onChange: (value: boolean) => handleChange("hideDockIcon", value),
				},
				{
					label: "Enable system notifications",
					type: "toggle",
					os: "macos",
					description:
						"Show system notifications for events like copying to clipboard, saving files, and more. You may need to manually allow Cap access via your system's notification settings.",
					get value() {
						return !!settings.enableNotifications;
					},
					onChange: async (value: boolean) => {
						if (value) {
							// Check current permission state
							console.log("Checking notification permission status");
							const permissionGranted = await isPermissionGranted();
							console.log(`Current permission status: ${permissionGranted}`);

							if (!permissionGranted) {
								// Request permission if not granted
								console.log("Permission not granted, requesting permission");
								const permission = await requestPermission();
								console.log(`Permission request result: ${permission}`);
								if (permission !== "granted") {
									// If permission denied, don't enable the setting
									console.log("Permission denied, aborting setting change");
									return;
								}
							}
						}
						handleChange("enableNotifications", value);
					},
				},
				{
					label: "Enable haptics",
					type: "toggle",
					os: "macos",
					description: "Use haptics on Force Touch™ trackpads",
					get value() {
						return !!settings.hapticsEnabled;
					},
					onChange: (value: boolean) => handleChange("hapticsEnabled", value),
				},
			],
		},
		{
			title: "Recording",
			items: [
				{
					label: "Recording countdown",
					description: "Countdown before recording starts",
					type: "select",
					get value() {
						return settings.recordingCountdown ?? 0;
					},
					onChange: (
						value:
							| MainWindowRecordingStartBehaviour
							| PostStudioRecordingBehaviour
							| PostDeletionBehaviour
							| number,
					) => handleChange("recordingCountdown", value as number),
				},
				{
					label: "Main window recording start behaviour",
					description: "The main window recording start behaviour",
					type: "select",
					get value() {
						return settings.mainWindowRecordingStartBehaviour ?? "close";
					},
					onChange: (
						value:
							| MainWindowRecordingStartBehaviour
							| PostStudioRecordingBehaviour
							| PostDeletionBehaviour
							| number,
					) =>
						handleChange(
							"mainWindowRecordingStartBehaviour",
							value as MainWindowRecordingStartBehaviour,
						),
				},
				{
					label: "Studio recording finish behaviour",
					description: "The studio recording finish behaviour",
					type: "select",
					get value() {
						return settings.postStudioRecordingBehaviour ?? "openEditor";
					},
					onChange: (
						value:
							| MainWindowRecordingStartBehaviour
							| PostStudioRecordingBehaviour
							| PostDeletionBehaviour
							| number,
					) =>
						handleChange(
							"postStudioRecordingBehaviour",
							value as PostStudioRecordingBehaviour,
						),
				},
				{
					label: "After deleting recording behaviour",
					description:
						"Should Cap reopen after deleting an in progress recording?",
					type: "select",
					get value() {
						return settings.postDeletionBehaviour ?? "doNothing";
					},
					onChange: (
						value:
							| MainWindowRecordingStartBehaviour
							| PostStudioRecordingBehaviour
							| PostDeletionBehaviour
							| number,
					) =>
						handleChange(
							"postDeletionBehaviour",
							value as PostDeletionBehaviour,
						),
				},
			],
		},
	];

	// Helper function to render select dropdown for recording behaviors
	const renderRecordingSelect = (
		label: string,
		description: string,
		getValue: () =>
			| MainWindowRecordingStartBehaviour
			| PostStudioRecordingBehaviour
			| PostDeletionBehaviour
			| number,
		onChange: (value: any) => void,
		options: { text: string; value: any }[],
	) => {
		return (
			<Setting label={label} description={description}>
				<button
					type="button"
					class="flex flex-row gap-1 text-xs bg-gray-3 items-center px-2.5 py-1.5 rounded-md border border-gray-4"
					onClick={async () => {
						const currentValue = getValue();
						const items = options.map((option) =>
							CheckMenuItem.new({
								text: option.text,
								checked: currentValue === option.value,
								action: () => onChange(option.value),
							}),
						);
						const menu = await Menu.new({
							items: await Promise.all(items),
						});
						await menu.popup();
						await menu.close();
					}}
				>
					{(() => {
						const currentValue = getValue();
						const option = options.find((opt) => opt.value === currentValue);
						return option ? option.text : currentValue;
					})()}
					<IconCapChevronDown class="size-4" />
				</button>
			</Setting>
		);
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-6">
				<AppearanceSection
					currentTheme={settings.theme ?? "system"}
					onThemeChange={(newTheme) => {
						setSettings("theme", newTheme);
						generalSettingsStore.set({ theme: newTheme });
					}}
				/>

				<For each={settingsGroups}>
					{(group) => (
						<Show when={group.os === ostype || !group.os}>
							<div>
								<h3
									class={cx(
										"mb-3 text-sm text-gray-12 w-fit",
										group.titleStyling,
									)}
								>
									{group.title}
								</h3>
								<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
									<For each={group.items}>
										{(item) => {
											// Check OS compatibility
											if (
												item.type === "toggle" &&
												item.os &&
												item.os !== ostype
											) {
												return null;
											}

											if (item.type === "toggle") {
												return (
													<ToggleSetting
														pro={group.title === "Cap Pro"}
														label={item.label}
														description={item.description}
														value={item.value}
														onChange={item.onChange}
													/>
												);
											} else if (item.type === "select") {
												if (
													item.label === "Main window recording start behaviour"
												) {
													return renderRecordingSelect(
														item.label,
														item.description,
														() => item.value,
														item.onChange,
														[
															{ text: "Close", value: "close" },
															{ text: "Minimise", value: "minimise" },
														],
													);
												} else if (
													item.label === "Studio recording finish behaviour"
												) {
													return renderRecordingSelect(
														item.label,
														item.description,
														() => item.value,
														item.onChange,
														[
															{ text: "Open editor", value: "openEditor" },
															{
																text: "Show in overlay",
																value: "showOverlay",
															},
														],
													);
												} else if (item.label === "Recording countdown") {
													return renderRecordingSelect(
														item.label,
														item.description,
														() => item.value,
														item.onChange,
														[
															{ text: "Off", value: 0 },
															{ text: "3 seconds", value: 3 },
															{ text: "5 seconds", value: 5 },
															{ text: "10 seconds", value: 10 },
														],
													);
												} else if (
													item.label === "After deleting recording behaviour"
												) {
													return renderRecordingSelect(
														item.label,
														item.description,
														() => item.value,
														item.onChange,
														[
															{ text: "Do Nothing", value: "doNothing" },
															{
																text: "Reopen Recording Window",
																value: "reopenRecordingWindow",
															},
														],
													);
												}
											}
											return null;
										}}
									</For>
								</div>
							</div>
							</Show>
					)}
				</For>

				<ExcludedWindowsCard
					excludedWindows={excludedWindows()}
					availableWindows={availableWindows()}
					onRemove={handleRemoveExclusion}
					onAdd={handleAddWindow}
					onReset={handleResetExclusions}
					isLoading={isExcludedWindowsLoading()}
					isWindows={ostype === "windows"}
				/>

				<ServerURLSetting
					value={settings.serverUrl ?? "https://cap.so"}
					onChange={async (v) => {
						const url = new URL(v);
						const origin = url.origin;

						if (
							!(await confirm(
								`Are you sure you want to change the server URL to '${origin}'? You will need to sign in again.`,
							))
						)
							return;

						await authStore.set(undefined);
						await commands.setServerUrl(origin);
						handleChange("serverUrl", origin);
					}}
				/>
			</div>
		</div>
	);
}

function ServerURLSetting(props: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [value, setValue] = createWritableMemo(() => props.value);

	return (
		<div class="flex flex-col gap-3">
			<h3 class="text-sm text-gray-12 w-fit">Self host</h3>
			<div class="flex flex-col gap-2 px-4 rounded-xl border border-gray-3 bg-gray-2">
				<Setting
					label="Cap Server URL"
					description="This setting should only be changed if you are self hosting your own instance of Cap Web."
				>
					<div class="flex flex-col gap-2 items-end">
						<Input
							class="bg-gray-3"
							value={value()}
							onInput={(e) => setValue(e.currentTarget.value)}
						/>
						<Button
							size="sm"
							class="mt-2"
							variant="dark"
							disabled={props.value === value()}
							onClick={() => props.onChange(value())}
						>
							Update
						</Button>
					</div>
				</Setting>
			</div>
		</div>
	);
}

function ExcludedWindowsCard(props: {
	excludedWindows: WindowExclusion[];
	availableWindows: CaptureWindowWithThumbnail[];
	onRemove: (index: number) => Promise<void>;
	onAdd: (window: CaptureWindowWithThumbnail) => Promise<void>;
	onReset: () => Promise<void>;
	isLoading: boolean;
	isWindows: boolean;
}) {
	const hasExclusions = () => props.excludedWindows.length > 0;
	const canAdd = () => props.availableWindows.length > 0 && !props.isLoading;

	const handleAddClick = async () => {
		if (!canAdd()) return;

		const items = await Promise.all(
			props.availableWindows.map((window) =>
				MenuItem.new({
					text: getWindowOptionLabel(window),
					action: () => {
						void props.onAdd(window);
					},
				}),
			),
		);

		const menu = await Menu.new({ items });
		await menu.popup();
		await menu.close();
	};

	return (
		<div class="flex flex-col gap-3 px-4 py-3 mt-6 rounded-xl border border-gray-3 bg-gray-2">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div class="flex flex-col gap-1">
					<p class="text-sm text-gray-12">Excluded Windows</p>
					<p class="text-xs text-gray-10">
						Choose which windows Cap hides from your recordings.
					</p>
					<Show when={props.isWindows}>
						<p class="text-xs text-gray-9">
							Only Cap windows can be excluded on Windows.
						</p>
					</Show>
				</div>
				<div class="flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={props.isLoading}
						onClick={() => {
							if (props.isLoading) return;
							void props.onReset();
						}}
					>
						Default
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={!canAdd()}
						onClick={() => void handleAddClick()}
						class="flex items-center gap-2"
					>
						<IconLucidePlus class="size-4" />
						Add
					</Button>
				</div>
			</div>
			<Show
				when={!props.isLoading}
				fallback={<ExcludedWindowsSkeleton />}
			>
				<Show
					when={hasExclusions()}
					fallback={
						<p class="text-xs text-gray-10">
							No windows are currently excluded.
						</p>
					}
				>
					<div class="flex flex-wrap gap-2">
						<For each={props.excludedWindows}>
							{(entry, index) => (
								<div class="group flex items-center gap-2 rounded-full border border-gray-4 bg-gray-3 px-3 py-1.5">
									<div class="flex flex-col leading-tight">
										<span class="text-sm text-gray-12">
											{getExclusionPrimaryLabel(entry)}
										</span>
										<Show when={getExclusionSecondaryLabel(entry)}>
											{(label) => (
												<span class="text-[0.65rem] text-gray-9">
													{label()}
												</span>
											)}
										</Show>
									</div>
									<button
										type="button"
										class="flex items-center justify-center rounded-full bg-gray-4/70 text-gray-11 transition-colors hover:bg-gray-5 hover:text-gray-12 size-6"
										onClick={() => void props.onRemove(index())}
										aria-label="Remove excluded window"
									>
										<IconLucideX class="size-3" />
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);
}

function ExcludedWindowsSkeleton() {
	const chipWidths = ["w-32", "w-28", "w-36"] as const;

	return (
		<div class="flex flex-wrap gap-2" aria-hidden="true">
			<For each={chipWidths}>
				{(width) => (
					<div class="flex items-center gap-2 rounded-full border border-gray-4 bg-gray-3 px-3 py-1.5 animate-pulse">
						<div class="flex flex-col gap-1 leading-tight">
							<div class={cx("h-3 rounded bg-gray-4", width)} />
							<div class="h-2 w-16 rounded bg-gray-4" />
						</div>
						<div class="size-6 rounded-full bg-gray-4" />
					</div>
				)}
			</For>
		</div>
	);
}
