import { Button } from "@inflight/ui-solid";
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
import {
	createEffect,
	createMemo,
	createResource,
	For,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLegacyAuto from "~/assets/theme-previews/legacy-auto.jpg";
import themePreviewLegacyDark from "~/assets/theme-previews/legacy-dark.jpg";
import themePreviewLegacyLight from "~/assets/theme-previews/legacy-light.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { SignInButton } from "~/components/SignInButton";
import { CloseIcon, DoubleArrowSwitcher, RestartIcon } from "~/icons";
import { Input } from "~/routes/editor/ui";
import { authStore, generalSettingsStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import { createOptionsQuery, createWorkspacesQuery } from "~/utils/queries";
import {
	type AppTheme,
	type CaptureWindow,
	commands,
	events,
	type GeneralSettingsStore,
	type MainWindowRecordingStartBehaviour,
	type PostDeletionBehaviour,
	type PostStudioRecordingBehaviour,
	type WindowExclusion,
} from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";
import { SettingItem, ToggleSettingItem } from "./Setting";

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

const getWindowOptionLabel = (window: CaptureWindow) => {
	const parts = [window.owner_name];
	if (window.name && window.name !== window.owner_name) {
		parts.push(window.name);
	}
	return parts.join(" • ");
};

type ExtendedGeneralSettingsStore = GeneralSettingsStore;

const createDefaultGeneralSettings = (): ExtendedGeneralSettingsStore => ({
	uploadIndividualFiles: false,
	hideDockIcon: false,
	autoCreateShareableLink: false,
	enableNotifications: true,
	enableNativeCameraPreview: false,
	enableNewRecordingFlow: true,
	recordingPickerPreferenceSet: false,
	autoZoomOnClicks: false,
	custom_cursor_capture2: true,
	excludedWindows: [],
	instantModeMaxResolution: 1920,
	defaultWorkspaceId: undefined,
});

const deriveInitialSettings = (
	store: GeneralSettingsStore | null,
): ExtendedGeneralSettingsStore => {
	const defaults = createDefaultGeneralSettings();
	if (!store) return defaults;

	return {
		...defaults,
		...store,
	};
};

const INSTANT_MODE_RESOLUTION_OPTIONS = [
	{ value: 1280, label: "720p" },
	{ value: 1920, label: "1080p" },
	{ value: 2560, label: "1440p" },
	{ value: 3840, label: "4K" },
] satisfies {
	value: number;
	label: string;
}[];

export default function GeneralSettings() {
	const [store] = createResource(() => generalSettingsStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

function AppearanceSection(props: {
	currentTheme: AppTheme;
	newRecordingFlow: boolean;
	onThemeChange: (theme: AppTheme) => void;
}) {
	const options = [
		{
			id: "system",
			name: "System",
		},
		{
			id: "light",
			name: "Light",
		},
		{
			id: "dark",
			name: "Dark",
		},
	] satisfies { id: AppTheme; name: string }[];

	const previews = createMemo(() => {
		return {
			system: props.newRecordingFlow
				? themePreviewAuto
				: themePreviewLegacyAuto,
			light: props.newRecordingFlow
				? themePreviewLight
				: themePreviewLegacyLight,
			dark: props.newRecordingFlow ? themePreviewDark : themePreviewLegacyDark,
		};
	});

	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-col pb-4 border-b border-gray-2">
				<h2 class="text-lg font-medium text-white">General</h2>
				<p class="text-sm text-gray-10">
					General settings of your Inflight application.
				</p>
			</div>
			<div
				class="flex justify-start items-center text-white"
				onContextMenu={(e) => e.preventDefault()}
			>
				<div class="flex flex-col gap-3">
					<p class="text-sm text-white">Appearance</p>
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
											<Show when={previews()[theme.id]} keyed>
												{(preview) => (
													<img
														class="animate-in fade-in duration-300"
														draggable={false}
														src={preview}
														alt={`Preview of ${theme.name} theme`}
													/>
												)}
											</Show>
										</div>
									</div>
									<span
										class={cx(`mt-2 text-sm transition-color duration-200`, {
											"text-white": props.currentTheme === theme.id,
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

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<ExtendedGeneralSettingsStore>(
		deriveInitialSettings(props.initialStore),
	);
	const auth = authStore.createQuery();
	const { setOptions: setRecordingOptions } = createOptionsQuery();

	createEffect(() => {
		setSettings(reconcile(deriveInitialSettings(props.initialStore)));
	});

	const [windows, { refetch: refetchWindows }] = createResource(
		async () => {
			// Fetch windows with a small delay to avoid blocking initial render
			await new Promise((resolve) => setTimeout(resolve, 100));
			return commands.listCaptureWindows();
		},
		{
			initialValue: [] as CaptureWindow[],
		},
	);

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
		extra?: Partial<GeneralSettingsStore>,
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		setSettings(key as keyof GeneralSettingsStore, value);
		generalSettingsStore.set({ [key]: value, ...(extra ?? {}) });

		// Update recording options to reflect the new default immediately
		if (key === "defaultWorkspaceId") {
			setRecordingOptions("workspaceId", value as string | null | undefined);
		}
	};

	const ostype: OsType = type();
	const excludedWindows = createMemo(() => settings.excludedWindows ?? []);
	const recordingWindowVariant = () =>
		settings.enableNewRecordingFlow === false ? "old" : "new";

	const updateRecordingWindowVariant = (variant: "new" | "old") => {
		const shouldUseNew = variant === "new";
		if (settings.enableNewRecordingFlow === shouldUseNew) return;
		handleChange("enableNewRecordingFlow", shouldUseNew, {
			recordingPickerPreferenceSet: true,
		});
	};

	const matchesExclusion = (
		exclusion: WindowExclusion,
		window: CaptureWindow,
	) => {
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

	const isManagedWindowsApp = (window: CaptureWindow) => {
		const bundle = window.bundle_identifier?.toLowerCase() ?? "";
		if (bundle.includes("co.inflight.desktop")) {
			return true;
		}
		return window.owner_name.toLowerCase().includes("inflight");
	};

	const isWindowAvailable = (window: CaptureWindow) => {
		if (excludedWindows().some((entry) => matchesExclusion(entry, window))) {
			return false;
		}
		if (ostype === "windows") {
			return isManagedWindowsApp(window);
		}
		return true;
	};

	const availableWindows = createMemo(() => {
		const data = windows() ?? [];
		return data.filter(isWindowAvailable);
	});

	const refreshAvailableWindows = async (): Promise<CaptureWindow[]> => {
		try {
			const refreshed = (await refetchWindows()) ?? windows() ?? [];
			return refreshed.filter(isWindowAvailable);
		} catch (error) {
			console.error("Failed to refresh available windows", error);
			return availableWindows();
		}
	};

	const applyExcludedWindows = async (windows: WindowExclusion[]) => {
		setSettings("excludedWindows", windows);
		try {
			await generalSettingsStore.set({ excludedWindows: windows });
			await commands.refreshWindowContentProtection();
			if (ostype === "macos") {
				await events.requestScreenCapturePrewarm.emit({ force: true });
			}
		} catch (error) {
			console.error("Failed to update excluded windows", error);
		}
	};

	const handleRemoveExclusion = async (index: number) => {
		const current = [...excludedWindows()];
		current.splice(index, 1);
		await applyExcludedWindows(current);
	};

	const handleAddWindow = async (window: CaptureWindow) => {
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

	const signIn = createSignInMutation();

	const handleAuth = async () => {
		if (auth.data) {
			trackEvent("user_signed_out", { platform: "desktop" });
			authStore.set(undefined);
		}
	};

	// Helper function to render select dropdown for recording behaviors
	const SelectSettingItem = <
		T extends
			| MainWindowRecordingStartBehaviour
			| PostStudioRecordingBehaviour
			| PostDeletionBehaviour
			| number,
	>(props: {
		label: string;
		description: string;
		value: T;
		onChange: (value: T) => void;
		options: { text: string; value: any }[];
	}) => {
		return (
			<SettingItem label={props.label} description={props.description}>
				<button
					type="button"
					class="flex flex-row gap-1 text-md text-white bg-white/5 items-center px-2.5 py-1.5 rounded-[8px] border border-white/5 hover:bg-white/10"
					onClick={async () => {
						const currentValue = props.value;
						const items = props.options.map((option) =>
							CheckMenuItem.new({
								text: option.text,
								checked: currentValue === option.value,
								action: () => props.onChange(option.value),
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
						const currentValue = props.value;
						const option = props.options.find(
							(opt) => opt.value === currentValue,
						);
						return option ? option.text : currentValue;
					})()}
					<IconCapChevronDown class="size-4" />
				</button>
			</SettingItem>
		);
	};

	// Workspace selection
	const workspaces = createWorkspacesQuery();
	const selectedWorkspace = createMemo(() => {
		const workspacesList = workspaces();
		if (!settings.defaultWorkspaceId && workspacesList.length > 0) {
			return workspacesList[0];
		}
		return (
			workspacesList.find((w) => w.id === settings.defaultWorkspaceId) ??
			workspacesList[0]
		);
	});

	const WorkspaceSelectSettingItem = () => {
		const workspacesList = workspaces();

		if (!auth.data || workspacesList.length === 0) {
			return null;
		}

		return (
			<SettingItem label="Default Workspace" description="">
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 h-8 rounded-[8px] border border-white/5 bg-white/5 hover:bg-white/10 text-md transition-colors"
					onClick={async () => {
						const items = await Promise.all(
							workspacesList.map((workspace) =>
								CheckMenuItem.new({
									text: workspace.name,
									action: () =>
										handleChange("defaultWorkspaceId", workspace.id),
									checked: selectedWorkspace()?.id === workspace.id,
								}),
							),
						);
						const menu = await Menu.new({ items });
						await menu.popup();
						await menu.close();
					}}
				>
					<Show when={selectedWorkspace()?.avatarUrl}>
						<img
							src={selectedWorkspace()?.avatarUrl ?? ""}
							alt=""
							class="size-4 rounded-full object-cover"
						/>
					</Show>
					<span class="text-white">
						{selectedWorkspace()?.name ?? "Select workspace"}
					</span>
					<DoubleArrowSwitcher class="size-3 text-gray-11" />
				</button>
			</SettingItem>
		);
	};

	const AccountSettingItem = () => {
		return (
			<SettingItem label="Account" description="">
				{auth.data ? (
					<button
						onClick={handleAuth}
						class="flex flex-row items-center justify-center h-8 px-2 rounded-[8px] text-white border border-white/5 bg-white/5 hover:bg-white/10"
					>
						<p class="text-md px-1">Log Out</p>
					</button>
				) : (
					<button
						class={`flex flex-row items-center justify-center h-8 px-2 rounded-[8px] text-white border border-white/5 ${
							signIn.isPending
								? "bg-white/5 hover:bg-white/10 !text-white"
								: "bg-blue-9 hover:bg-blue-10"
						}`}
						onClick={() => {
							if (signIn.isPending) {
								signIn.variables.abort();
								signIn.reset();
							} else {
								signIn.mutate(new AbortController());
							}
						}}
					>
						{signIn.isPending ? "Cancel Sign In" : "Sign In"}
					</button>
				)}
			</SettingItem>
		);
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-0 space-y-4">
				{/* <AppearanceSection
					currentTheme={settings.theme ?? "system"}
					newRecordingFlow={settings.enableNewRecordingFlow}
					onThemeChange={(newTheme) => {
						setSettings("theme", newTheme);
						generalSettingsStore.set({ theme: newTheme });
					}}
				/> */}

				{/* <SettingGroup title="Cap Pro" titleStyling="bg-blue-500 py-1.5 mb-4 text-white text-xs px-2 rounded-lg">
					<ToggleSettingItem
						label="Automatically open shareable links"
						description="Whether Cap should automatically open instant recordings in your browser"
						value={!settings.disableAutoOpenLinks}
						onChange={(v) => handleChange("disableAutoOpenLinks", !v)}
					/>
				</SettingGroup> */}

				{/* {ostype === "macos" && (
					<SettingGroup title="App">
						<ToggleSettingItem
							label="Always show dock icon"
							description="Show Cap in the dock even when there are no windows available to close."
							value={!settings.hideDockIcon}
							onChange={(v) => handleChange("hideDockIcon", !v)}
						/>
						<ToggleSettingItem
							label="Enable system notifications"
							description="Show system notifications for events like copying to clipboard, saving files, and more. You may need to manually allow Cap access via your system's notification settings."
							value={!!settings.enableNotifications}
							onChange={async (value) => {
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
							}}
						/>
					</SettingGroup>
				)} */}

				<SettingGroup title="">
					<AccountSettingItem />
					<Show when={auth.data && workspaces().length > 0}>
						<WorkspaceSelectSettingItem />
					</Show>
				</SettingGroup>

				<SettingGroup title="">
					<SelectSettingItem
						label="Recording countdown"
						description=""
						value={settings.recordingCountdown ?? 0}
						onChange={(value) => handleChange("recordingCountdown", value)}
						options={[
							{ text: "Off", value: 0 },
							{ text: "3 seconds", value: 3 },
							{ text: "5 seconds", value: 5 },
							{ text: "10 seconds", value: 10 },
						]}
					/>
					<SelectSettingItem
						label="Video Resolution"
						description=""
						value={settings.instantModeMaxResolution ?? 1920}
						onChange={(value) =>
							handleChange("instantModeMaxResolution", value)
						}
						options={INSTANT_MODE_RESOLUTION_OPTIONS.map((option) => ({
							text: option.label,
							value: option.value,
						}))}
					/>
					{/* <SelectSettingItem
						label="Main window recording start behaviour"
						description="The main window recording start behaviour"
						value={settings.mainWindowRecordingStartBehaviour ?? "close"}
						onChange={(value) => handleChange("mainWindowRecordingStartBehaviour", value)}
						options={[
							{ text: "Close", value: "close" },
							{ text: "Minimise", value: "minimise" },
						]}
					/> */}
					{/* <SelectSettingItem
						label="Studio recording finish behaviour"
						description="The studio recording finish behaviour"
						value={settings.postStudioRecordingBehaviour ?? "openEditor"}
						onChange={(value) => handleChange("postStudioRecordingBehaviour", value)}
						options={[
							{ text: "Open editor", value: "openEditor" },
							{
								text: "Show in overlay",
								value: "showOverlay",
							},
						]}
					/> */}
					{/* <SelectSettingItem
						label="After deleting recording behaviour"
						description="Should Cap reopen after deleting an in progress recording?"
						value={settings.postDeletionBehaviour ?? "doNothing"}
						onChange={(value) => handleChange("postDeletionBehaviour", value)}
						options={[
							{ text: "Do Nothing", value: "doNothing" },
							{
								text: "Reopen Recording Window",
								value: "reopenRecordingWindow",
							},
						]}
					/> */}
					{/* <ToggleSettingItem
						label="Delete instant mode recordings after upload"
						description="After finishing an instant recording, should Cap will delete it from your device?"
						value={settings.deleteInstantRecordingsAfterUpload ?? false}
						onChange={(v) => handleChange("deleteInstantRecordingsAfterUpload", v)}
					/> */}
				</SettingGroup>

				<ExcludedWindowsCard
					excludedWindows={excludedWindows()}
					availableWindows={availableWindows()}
					onRequestAvailableWindows={refreshAvailableWindows}
					onRemove={handleRemoveExclusion}
					onAdd={handleAddWindow}
					onReset={handleResetExclusions}
					isLoading={windows.loading}
					isWindows={ostype === "windows"}
				/>

				{/* <ServerURLSetting
					value={settings.serverUrl ?? "https://cap.so"}
					onChange={async (v) => {
						const url = new URL(v);
						const origin = url.origin;

						if (
							!(await confirm(
								`Are you sure you want to change the server URL to '${origin}'? You will need to sign in again.`
							))
						)
							return;

						await authStore.set(undefined);
						await commands.setServerUrl(origin);
						handleChange("serverUrl", origin);
					}}
				/> */}
			</div>
		</div>
	);
}

function SettingGroup(
	props: ParentProps<{ title: string; titleStyling?: string }>,
) {
	return (
		<div>
			{props.title && (
				<h3 class={cx("mb-3 text-sm text-white w-fit", props.titleStyling)}>
					{props.title}
				</h3>
			)}
			<div
				class="px-4 rounded-xl divide-y divide-white/5 bg-white/5"
				style={{
					"box-shadow": "0 1px 2px 0 rgba(255,255,255,0.05) inset",
				}}
			>
				{props.children}
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
			<h3 class="text-sm text-white w-fit">Self host</h3>
			<div class="flex flex-col gap-2 px-4 rounded-xl border border-white/5 bg-white/5">
				<SettingItem
					label="Cap Server URL"
					description="This setting should only be changed if you are self hosting your own instance of Cap Web."
				>
					<div class="flex flex-col gap-2 items-end">
						<Input
							class="bg-white/5"
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
				</SettingItem>
			</div>
		</div>
	);
}

function ExcludedWindowsCard(props: {
	excludedWindows: WindowExclusion[];
	availableWindows: CaptureWindow[];
	onRequestAvailableWindows: () => Promise<CaptureWindow[]>;
	onRemove: (index: number) => Promise<void>;
	onAdd: (window: CaptureWindow) => Promise<void>;
	onReset: () => Promise<void>;
	isLoading: boolean;
	isWindows: boolean;
}) {
	const hasExclusions = () => props.excludedWindows.length > 0;
	const canAdd = () => !props.isLoading;

	const handleAddClick = async (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();

		if (!canAdd()) return;

		// Use available windows if we have them, otherwise fetch
		let windows = props.availableWindows;

		// Only refresh if we don't have any windows cached
		if (!windows.length) {
			try {
				windows = await props.onRequestAvailableWindows();
			} catch (error) {
				console.error("Failed to fetch windows:", error);
				return;
			}
		}

		if (!windows.length) {
			console.log("No available windows to exclude");
			return;
		}

		try {
			const items = await Promise.all(
				windows.map((window) =>
					MenuItem.new({
						text: getWindowOptionLabel(window),
						action: () => {
							void props.onAdd(window);
						},
					}),
				),
			);

			const menu = await Menu.new({ items });

			// Save scroll position before popup
			const scrollPos = window.scrollY;

			await menu.popup();
			await menu.close();

			// Restore scroll position after menu closes
			requestAnimationFrame(() => {
				window.scrollTo(0, scrollPos);
			});
		} catch (error) {
			console.error("Error showing window menu:", error);
		}
	};

	return (
		<div
			class="flex flex-col gap-3 px-4 py-3 mt-6 rounded-[16px] bg-white/5"
			style={{
				"box-shadow": "0 1px 2px 0 rgba(255,255,255,0.05) inset",
			}}
		>
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div class="flex flex-col gap-1">
					<p class="text-sm text-white">Excluded Windows</p>
					<p class="text-xs text-gray-11">
						Choose which windows Inflight hides in your recording
					</p>
					<Show when={props.isWindows}>
						<p class="text-xs text-gray-11">
							<span class="font-medium text-white">Note:</span> Only Inflight
							related windows can be excluded on Windows due to technical
							limitations.
						</p>
					</Show>
				</div>
				<div class="flex gap-2">
					<button
						disabled={props.isLoading}
						onClick={() => {
							if (props.isLoading) return;
							void props.onReset();
						}}
						class="flex items-center justify-center gap-0 size-6 rounded-[6px] border border-white/5 bg-white/5 hover:bg-white/10 group"
						style={{
							"box-shadow":
								"0 1px 1px -0.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16))",
						}}
					>
						<RestartIcon class="size-4 text-gray-10 group-hover:text-white" />
					</button>
					<button
						disabled={!canAdd()}
						onClick={(e) => void handleAddClick(e)}
						class="flex items-center gap-0 px-1 h-6 rounded-[6px] bg-white/5 border border-white/5 hover:bg-white/10"
					>
						<IconLucidePlus class="size-4 text-white" />
						<span class="text-sm text-white px-1">Add</span>
					</button>
				</div>
			</div>
			<Show when={!props.isLoading} fallback={<ExcludedWindowsSkeleton />}>
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
								<div
									class="group flex items-center justify-between gap-1 px-2 py-1.5 rounded-[8px] border border-white/5 bg-white/5"
									style={{
										"box-shadow":
											"0 1px 1px -0.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16))",
									}}
								>
									<div class="flex flex-col leading-tight px-1">
										<span class="text-sm text-white">
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
										class="flex items-center justify-center size-4"
										onClick={() => void props.onRemove(index())}
										aria-label="Remove excluded window"
									>
										<CloseIcon class="size-4 text-gray-9 hover:text-white" />
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
					<div class="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-3 py-1.5 animate-pulse">
						<div class="flex flex-col gap-1 leading-tight">
							<div class={cx("h-3 rounded bg-white/10", width)} />
							<div class="h-2 w-16 rounded bg-white/10" />
						</div>
						<div class="size-6 rounded-full bg-white/10" />
					</div>
				)}
			</For>
		</div>
	);
}
