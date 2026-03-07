import { Button } from "@cap/ui-solid";
import { createWritableMemo } from "@solid-primitives/memo";
import {
	isPermissionGranted,
	requestPermission,
} from "@tauri-apps/plugin-notification";
import { type OsType, type } from "@tauri-apps/plugin-os";
import "@total-typescript/ts-reset/filter-boolean";
import { Collapsible } from "@kobalte/core/collapsible";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	onMount,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { Input } from "~/routes/editor/ui";
import { authStore, generalSettingsStore } from "~/store";
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
	disableUpdateChecks: false,
	autoCreateShareableLink: false,
	enableNotifications: true,
	enableNativeCameraPreview: false,
	autoZoomOnClicks: false,
	custom_cursor_capture2: true,
	excludedWindows: [],
	instantModeMaxResolution: 1920,
	crashRecoveryRecording: true,
	maxFps: 60,
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

const MAX_FPS_OPTIONS = [
	{ value: 30, label: "30 FPS" },
	{ value: 60, label: "60 FPS (Recommended)" },
	{ value: 120, label: "120 FPS" },
] satisfies {
	value: number;
	label: string;
}[];

const DEFAULT_PROJECT_NAME_TEMPLATE =
	"{target_name} ({target_kind}) {date} {time}";

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

	const previews = {
		system: themePreviewAuto,
		light: themePreviewLight,
		dark: themePreviewDark,
	};

	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-col border-b border-gray-2">
				<h2 class="text-lg font-medium text-gray-12">General Settings</h2>
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
											<Show when={previews[theme.id]} keyed>
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

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<ExtendedGeneralSettingsStore>(
		deriveInitialSettings(props.initialStore),
	);

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
	};

	const ostype: OsType = type();
	const excludedWindows = createMemo(() => settings.excludedWindows ?? []);

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
		if (bundle.includes("so.cap.desktop")) {
			return true;
		}
		return window.owner_name.toLowerCase().includes("cap");
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
					class="flex flex-row gap-1 text-xs bg-gray-3 items-center px-2.5 py-1.5 rounded-md border border-gray-4"
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

				{ostype === "macos" && (
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
									console.log(
										`Current permission status: ${permissionGranted}`,
									);

									if (!permissionGranted) {
										// Request permission if not granted
										console.log(
											"Permission not granted, requesting permission",
										);
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
				)}

				<SettingGroup title="Recording">
					<SelectSettingItem
						label="Instant mode max resolution"
						description="Choose the maximum resolution for Instant Mode recordings."
						value={settings.instantModeMaxResolution ?? 1920}
						onChange={(value) =>
							handleChange("instantModeMaxResolution", value)
						}
						options={INSTANT_MODE_RESOLUTION_OPTIONS.map((option) => ({
							text: option.label,
							value: option.value,
						}))}
					/>
					<SelectSettingItem
						label="Recording countdown"
						description="Countdown before recording starts"
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
						label="Main window recording start behaviour"
						description="The main window recording start behaviour"
						value={settings.mainWindowRecordingStartBehaviour ?? "close"}
						onChange={(value) =>
							handleChange("mainWindowRecordingStartBehaviour", value)
						}
						options={[
							{ text: "Close", value: "close" },
							{ text: "Minimise", value: "minimise" },
						]}
					/>
					<SelectSettingItem
						label="Studio recording finish behaviour"
						description="The studio recording finish behaviour"
						value={settings.postStudioRecordingBehaviour ?? "openEditor"}
						onChange={(value) =>
							handleChange("postStudioRecordingBehaviour", value)
						}
						options={[
							{ text: "Open editor", value: "openEditor" },
							{
								text: "Show in overlay",
								value: "showOverlay",
							},
						]}
					/>
					<SelectSettingItem
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
					/>
					<ToggleSettingItem
						label="Delete instant mode recordings after upload"
						description="After finishing an instant recording, should Cap will delete it from your device?"
						value={settings.deleteInstantRecordingsAfterUpload ?? false}
						onChange={(v) =>
							handleChange("deleteInstantRecordingsAfterUpload", v)
						}
					/>
					<ToggleSettingItem
						label="Crash-recoverable recording"
						description="Records in fragmented segments that can be recovered if the app crashes or your system loses power. May have slightly higher storage usage during recording."
						value={settings.crashRecoveryRecording ?? true}
						onChange={(value) => handleChange("crashRecoveryRecording", value)}
					/>
					<div class="flex flex-col gap-1">
						<SelectSettingItem
							label="Max capture framerate"
							description="Maximum framerate for screen capture. Higher values may cause instability on some systems."
							value={settings.maxFps ?? 60}
							onChange={(value) => handleChange("maxFps", value)}
							options={MAX_FPS_OPTIONS.map((option) => ({
								text: option.label,
								value: option.value,
							}))}
						/>
						{(settings.maxFps ?? 60) > 60 && (
							<p class="text-xs text-amber-500 px-1 pb-2">
								⚠️ Higher framerates may cause frame drops or increased CPU usage
								on some systems.
							</p>
						)}
					</div>
				</SettingGroup>

				<SettingGroup
					title="Cap Pro Settings"
					titleStyling="bg-blue-500 py-1.5 mb-4 text-white text-xs px-2 rounded-lg"
				>
					<ToggleSettingItem
						label="Automatically open shareable links"
						description="Whether Cap should automatically open instant recordings in your browser"
						value={!settings.disableAutoOpenLinks}
						onChange={(v) => handleChange("disableAutoOpenLinks", !v)}
					/>
				</SettingGroup>

				<DefaultProjectNameCard
					onChange={(value) =>
						handleChange("defaultProjectNameTemplate", value)
					}
					value={settings.defaultProjectNameTemplate ?? null}
				/>

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
				<SettingGroup title="Update Settings">
					<ToggleSettingItem
						label="Disable update checks"
						description="Disable automatic update checks."
						value={!!settings.disableUpdateChecks}
						onChange={(v) => handleChange("disableUpdateChecks", v)}
					/>
				</SettingGroup>
			</div>
		</div>
	);
}

function SettingGroup(
	props: ParentProps<{ title: string; titleStyling?: string }>,
) {
	return (
		<div>
			<h3 class={cx("mb-3 text-sm text-gray-12 w-fit", props.titleStyling)}>
				{props.title}
			</h3>
			<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
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
			<h3 class="text-sm text-gray-12 w-fit">Self host</h3>
			<div class="flex flex-col gap-2 px-4 rounded-xl border border-gray-3 bg-gray-2">
				<SettingItem
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
				</SettingItem>
			</div>
		</div>
	);
}

function DefaultProjectNameCard(props: {
	value: string | null;
	onChange: (name: string | null) => Promise<void>;
}) {
	const MOMENT_EXAMPLE_TEMPLATE = "{moment:DDDD, MMMM D, YYYY h:mm A}";
	const macos = type() === "macos";
	const today = new Date();
	const datetime = new Date(
		today.getFullYear(),
		today.getMonth(),
		today.getDate(),
		macos ? 9 : 12,
		macos ? 41 : 0,
		0,
		0,
	).toISOString();

	let inputRef: HTMLInputElement | undefined;

	const dateString = today.toISOString().split("T")[0];
	const initialTemplate = () => props.value ?? DEFAULT_PROJECT_NAME_TEMPLATE;

	const [inputValue, setInputValue] = createSignal<string>(initialTemplate());
	const [preview, setPreview] = createSignal<string | null>(null);
	const [momentExample, setMomentExample] = createSignal("");

	async function updatePreview(val = inputValue()) {
		const formatted = await commands.formatProjectName(
			val,
			macos ? "Safari" : "Chrome",
			"Window",
			"instant",
			datetime,
		);
		setPreview(formatted);
	}

	onMount(() => {
		commands
			.formatProjectName(
				MOMENT_EXAMPLE_TEMPLATE,
				macos ? "Safari" : "Chrome",
				"Window",
				"instant",
				datetime,
			)
			.then(setMomentExample);

		const seed = initialTemplate();
		setInputValue(seed);
		if (inputRef) inputRef.value = seed;
		updatePreview(seed);
	});

	const isSaveDisabled = () => {
		const input = inputValue();
		return (
			!input ||
			input === (props.value ?? DEFAULT_PROJECT_NAME_TEMPLATE) ||
			input.length <= 3
		);
	};

	function CodeView(props: { children: string }) {
		return (
			<button
				type="button"
				title="Click to copy"
				class="bg-gray-1 hover:bg-gray-5 rounded-md m-0.5 p-0.5 cursor-pointer transition-[color,background-color,transform] ease-out duration-200 active:scale-95"
				onClick={() => commands.writeClipboardString(props.children)}
			>
				<code>{props.children}</code>
			</button>
		);
	}

	return (
		<div class="flex flex-col gap-3 px-4 py-3 mt-6 rounded-xl border border-gray-3 bg-gray-2">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div class="flex flex-col gap-1">
					<p class="text-sm text-gray-12">Default Project Name</p>
					<p class="text-xs text-gray-10">
						Choose the template to use as the default project and file name.
					</p>
				</div>
				<div class="flex flex-shrink-0 gap-2">
					<Button
						size="sm"
						variant="gray"
						disabled={
							inputValue() === DEFAULT_PROJECT_NAME_TEMPLATE &&
							inputValue() !== props.value
						}
						onClick={async () => {
							await props.onChange(null);
							const newTemplate = initialTemplate();
							setInputValue(newTemplate);
							if (inputRef) inputRef.value = newTemplate;
							await updatePreview(newTemplate);
						}}
					>
						Reset
					</Button>

					<Button
						size="sm"
						variant="dark"
						disabled={isSaveDisabled()}
						onClick={async () => {
							await props.onChange(inputValue() ?? null);
							await updatePreview();
						}}
					>
						Save
					</Button>
				</div>
			</div>

			<div class="flex flex-col gap-2 w-full">
				<Input
					autocorrect="off"
					ref={inputRef}
					type="text"
					class="bg-gray-3 font-mono"
					value={inputValue()}
					onInput={(e) => {
						setInputValue(e.currentTarget.value);
						updatePreview(e.currentTarget.value);
					}}
				/>

				<div class="w-full flex items-center py-2 px-2 rounded-lg bg-gray-transparent-50 border border-dashed border-gray-5">
					<IconCapLogo class="size-4 pointer-events-none mr-2" />
					<p class="whitespace-pre-wrap">{preview()}</p>
				</div>

				<Collapsible class="w-full rounded-lg">
					<Collapsible.Trigger class="group inline-flex items-center w-full text-xs rounded-lg outline-none px-0.5 py-1">
						<IconCapChevronDown class="size-4 ui-group-expanded:rotate-180 transition-transform duration-300 ease-in-out" />
						<p class="py-0.5 px-1">How to customize?</p>
					</Collapsible.Trigger>

					<Collapsible.Content class="opacity-0 transition animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100 text-xs text-gray-12 space-y-3 px-1 pb-2">
						<p class="border-t pt-3">
							Use placeholders in your template that will be automatically
							filled in.
						</p>

						<div class="space-y-1">
							<p class="font-medium text-foreground">Recording Mode</p>
							<p>
								<CodeView>{"{recording_mode}"}</CodeView> → "Studio", "Instant",
								or "Screenshot"
							</p>
							<p>
								<CodeView>{"{mode}"}</CodeView> → "studio", "instant", or
								"screenshot"
							</p>
						</div>

						<div class="space-y-1">
							<p class="font-medium text-foreground">Target</p>
							<p>
								<CodeView>{"{target_kind}"}</CodeView> → "Display", "Window", or
								"Area"
							</p>
							<p>
								<CodeView>{"{target_name}"}</CodeView> → The name of the monitor
								or the title of the app depending on the recording mode.
							</p>
						</div>

						<div class="space-y-1">
							<p class="font-medium text-foreground">Date &amp; Time</p>
							<p>
								<CodeView>{"{date}"}</CodeView> → {dateString}
							</p>
							<p>
								<CodeView>{"{time}"}</CodeView> →{" "}
								{macos ? "09:41 AM" : "12:00 PM"}
							</p>
						</div>

						<div class="space-y-1">
							<p class="font-medium text-foreground">Custom Formats</p>
							<p>
								You can also use a custom format for time. The placeholders are
								case-sensitive. For 24-hour time, use{" "}
								<CodeView>{"{moment:HH:mm}"}</CodeView> or use lower cased{" "}
								<code>hh</code> for 12-hour format.
							</p>
							<p class="flex flex-col items-start pt-1">
								<CodeView>{MOMENT_EXAMPLE_TEMPLATE}</CodeView> →{" "}
								{momentExample()}
							</p>
						</div>
					</Collapsible.Content>
				</Collapsible>
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
		<div class="flex flex-col gap-3 px-4 py-3 mt-6 rounded-xl border border-gray-3 bg-gray-2">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div class="flex flex-col gap-1">
					<p class="text-sm text-gray-12">Excluded Windows</p>
					<p class="text-xs text-gray-10">
						Choose which windows Cap hides from your recordings.
					</p>
					<Show when={props.isWindows}>
						<p class="text-xs text-gray-9">
							<span class="font-medium text-gray-11">Note:</span> Only Cap
							related windows can be excluded on Windows due to technical
							limitations.
						</p>
					</Show>
				</div>
				<div class="flex flex-shrink-0 gap-2">
					<Button
						variant="gray"
						size="sm"
						disabled={props.isLoading}
						onClick={() => {
							if (props.isLoading) return;
							void props.onReset();
						}}
					>
						Reset to Default
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={!canAdd()}
						onClick={(e) => void handleAddClick(e)}
						class="flex items-center gap-2"
					>
						<IconLucidePlus class="size-4" />
						Add
					</Button>
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
