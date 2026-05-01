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
	type JSX,
	onCleanup,
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
	deriveGeneralSettings,
	type GeneralSettingsStore,
} from "~/utils/general-settings";
import {
	type AppTheme,
	type CaptureWindow,
	commands,
	events,
	type MainWindowRecordingStartBehaviour,
	type PostDeletionBehaviour,
	type PostStudioRecordingBehaviour,
	type StudioRecordingQuality,
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
		{ id: "system", name: "System" },
		{ id: "light", name: "Light" },
		{ id: "dark", name: "Dark" },
	] satisfies { id: AppTheme; name: string }[];

	const previews = {
		system: themePreviewAuto,
		light: themePreviewLight,
		dark: themePreviewDark,
	};

	return (
		<Section
			title="Appearance"
			description="Match Cap to your system theme or pick a fixed look."
		>
			<SectionCard padded>
				<div
					class="grid grid-cols-3 gap-3"
					onContextMenu={(e) => e.preventDefault()}
				>
					<For each={options}>
						{(theme) => {
							const isSelected = () => props.currentTheme === theme.id;
							return (
								<button
									type="button"
									aria-checked={isSelected()}
									aria-label={`Select theme: ${theme.name}`}
									onClick={() => props.onThemeChange(theme.id)}
									class="flex flex-col gap-2 items-center group focus:outline-none"
								>
									<div
										class={cx(
											"w-full aspect-[5/3] rounded-lg overflow-hidden border-2 transition-all duration-150",
											isSelected()
												? "border-blue-9"
												: "border-gray-4 group-hover:border-gray-6",
										)}
									>
										<Show when={previews[theme.id]} keyed>
											{(preview) => (
												<img
													class="object-cover w-full h-full animate-in fade-in duration-200"
													draggable={false}
													src={preview}
													alt={`Preview of ${theme.name} theme`}
												/>
											)}
										</Show>
									</div>
									<span
										class={cx(
											"text-xs font-medium transition-colors",
											isSelected() ? "text-gray-12" : "text-gray-10",
										)}
									>
										{theme.name}
									</span>
								</button>
							);
						}}
					</For>
				</div>
			</SectionCard>
		</Section>
	);
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<ExtendedGeneralSettingsStore>(
		deriveGeneralSettings(props.initialStore),
	);

	createEffect(() => {
		setSettings(reconcile(deriveGeneralSettings(props.initialStore)));
	});

	let scrollContainerRef: HTMLDivElement | undefined;

	const scrollToSection = (section: string) => {
		try {
			localStorage.removeItem("cap.settings.scrollToSection");
		} catch { }
		const attempt = (remaining: number) => {
			const target = document.getElementById(`settings-section-${section}`);
			const container = scrollContainerRef;
			if (!target || !container) {
				if (remaining > 0) {
					window.setTimeout(() => attempt(remaining - 1), 50);
				}
				return;
			}
			const containerRect = container.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			const offset =
				targetRect.top - containerRect.top + container.scrollTop - 8;
			container.scrollTo({ top: offset, behavior: "smooth" });
			target.classList.add("settings-section-pulse");
			window.setTimeout(() => {
				target.classList.remove("settings-section-pulse");
			}, 1600);
		};
		attempt(10);
	};

	onMount(() => {
		let pending: string | null = null;
		try {
			pending = localStorage.getItem("cap.settings.scrollToSection");
		} catch { }
		if (pending) {
			scrollToSection(pending);
		}

		const unlisten = events.requestScrollToSettingsSection.listen((event) => {
			scrollToSection(event.payload.section);
		});
		onCleanup(() => {
			unlisten.then((cb) => cb()).catch(() => { });
		});
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
		| StudioRecordingQuality
		| number,
	>(props: {
		label: string;
		description: string;
		value: T;
		onChange: (value: T) => void;
		options: { text: string; value: T }[];
	}) => {
		return (
			<SettingItem label={props.label} description={props.description}>
				<button
					type="button"
					class="flex flex-row gap-1.5 text-xs items-center px-2.5 py-1.5 rounded-lg border transition-colors bg-gray-3 hover:bg-gray-4 text-gray-12 border-gray-4"
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
					<IconCapChevronDown class="size-3.5 text-gray-10" />
				</button>
			</SettingItem>
		);
	};

	return (
		<div ref={scrollContainerRef} class="flex flex-col h-full custom-scroll">
			<div class="px-6 py-6 space-y-7 max-w-[42rem]">
				<AppearanceSection
					currentTheme={settings.theme ?? "system"}
					onThemeChange={(newTheme) => {
						setSettings("theme", newTheme);
						generalSettingsStore.set({ theme: newTheme });
					}}
				/>

				{ostype === "macos" && (
					<Section
						title="App"
						description="Choose how Cap shows up on your system."
					>
						<SectionRows>
							<ToggleSettingItem
								label="Always show dock icon"
								description="Keep Cap in the dock even when no windows are open."
								value={!settings.hideDockIcon}
								onChange={(v) => handleChange("hideDockIcon", !v)}
							/>
							<ToggleSettingItem
								label="System notifications"
								description="Show notifications for clipboard copies, saved files, and more. You may need to allow Cap in your system's notification settings."
								value={!!settings.enableNotifications}
								onChange={async (value) => {
									if (value) {
										const permissionGranted = await isPermissionGranted();
										if (!permissionGranted) {
											const permission = await requestPermission();
											if (permission !== "granted") return;
										}
									}
									handleChange("enableNotifications", value);
								}}
							/>
						</SectionRows>
					</Section>
				)}

				<QualitySection
					studioQuality={settings.studioRecordingQuality ?? "balanced"}
					onStudioQualityChange={(value) =>
						handleChange("studioRecordingQuality", value)
					}
					instantResolution={settings.instantModeMaxResolution ?? 1920}
					onInstantResolutionChange={(value) =>
						handleChange("instantModeMaxResolution", value)
					}
				/>

				<Section
					title="Recording"
					description="Behaviour while you record and after you stop."
				>
					<SectionRows>
						<SelectSettingItem
							label="Countdown"
							description="Wait before the recording starts."
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
							label="Main window when recording starts"
							description="What happens to the main window once a recording begins."
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
							label="After a Studio recording"
							description="What happens once you stop a Studio recording."
							value={settings.postStudioRecordingBehaviour ?? "openEditor"}
							onChange={(value) =>
								handleChange("postStudioRecordingBehaviour", value)
							}
							options={[
								{ text: "Open editor", value: "openEditor" },
								{ text: "Show in overlay", value: "showOverlay" },
							]}
						/>
						<SelectSettingItem
							label="After deleting a recording"
							description="Whether the recording window should reopen."
							value={settings.postDeletionBehaviour ?? "doNothing"}
							onChange={(value) => handleChange("postDeletionBehaviour", value)}
							options={[
								{ text: "Do nothing", value: "doNothing" },
								{
									text: "Reopen recording window",
									value: "reopenRecordingWindow",
								},
							]}
						/>
						<ToggleSettingItem
							label="Delete Instant recordings after upload"
							description="Cap removes the local file once it has uploaded successfully."
							value={settings.deleteInstantRecordingsAfterUpload ?? false}
							onChange={(v) =>
								handleChange("deleteInstantRecordingsAfterUpload", v)
							}
						/>
						<ToggleSettingItem
							label="Crash-recoverable recording"
							description="Record in fragments that can be recovered after a crash or power loss. Slightly larger files during capture."
							value={settings.crashRecoveryRecording ?? true}
							onChange={(value) =>
								handleChange("crashRecoveryRecording", value)
							}
						/>
						<ToggleSettingItem
							label="Custom cursor capture (Studio)"
							description="Capture cursor state separately so you can adjust size and smoothing in the editor."
							value={!!settings.custom_cursor_capture2}
							onChange={(value) =>
								handleChange("custom_cursor_capture2", value)
							}
						/>
						<ToggleSettingItem
							label="Auto zoom on clicks"
							description="Automatically add zoom segments around mouse clicks in Studio recordings."
							value={!!settings.autoZoomOnClicks}
							onChange={(value) => handleChange("autoZoomOnClicks", value)}
						/>
						<ToggleSettingItem
							label="Capture keyboard presses"
							description="Record key presses so you can add keyboard overlays in the editor."
							value={!!settings.captureKeyboardEvents}
							onChange={(value) => handleChange("captureKeyboardEvents", value)}
						/>
						<SelectSettingItem
							label="Max capture framerate"
							description={
								(settings.maxFps ?? 60) > 60
									? "Maximum framerate for screen capture. Higher values may cause drops or increased CPU usage on some systems."
									: "Maximum framerate for screen capture."
							}
							value={settings.maxFps ?? 60}
							onChange={(value) => handleChange("maxFps", value)}
							options={MAX_FPS_OPTIONS.map((option) => ({
								text: option.label,
								value: option.value,
							}))}
						/>
					</SectionRows>
				</Section>

				<Section
					title="Cap Pro"
					description="Settings available with a Cap Pro license."
					pro
				>
					<SectionRows>
						<ToggleSettingItem
							label="Auto-open shareable links"
							description="Open the share link in your browser as soon as the upload finishes."
							value={!settings.disableAutoOpenLinks}
							onChange={(v) => handleChange("disableAutoOpenLinks", !v)}
						/>
					</SectionRows>
				</Section>

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

				<TelemetryCard
					value={settings.enableTelemetry !== false}
					onChange={(v) => handleChange("enableTelemetry", v)}
				/>
			</div>
		</div>
	);
}

function TelemetryCard(props: {
	value: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<Section title="Privacy">
			<SectionRows>
				<ToggleSettingItem
					label="Share anonymous telemetry"
					description="Cap uses anonymous telemetry to improve reliability and fix bugs. We never collect recording contents, window titles, file paths, or personal information."
					value={props.value}
					onChange={props.onChange}
				/>
			</SectionRows>
		</Section>
	);
}

type StudioQualityTier = {
	value: StudioRecordingQuality;
	label: string;
	summary: string;
	bestFor: string;
};

const STUDIO_QUALITY_TIERS: StudioQualityTier[] = [
	{
		value: "compatibility",
		label: "Compatibility",
		summary: "Lower bitrate to keep older or low-power machines smooth.",
		bestFor: "Older Intel Macs, 8GB MacBook Air, weaker laptops.",
	},
	{
		value: "balanced",
		label: "Balanced",
		summary: "Sharp footage with sensible CPU and disk usage.",
		bestFor: "Most modern Macs and PCs with 16GB+ RAM.",
	},
	{
		value: "ultra",
		label: "Ultra",
		summary: "Maximum detail for color-graded, large-display edits.",
		bestFor: "M-series Pro/Max, discrete GPUs, 32GB+ RAM, NVMe.",
	},
];

type InstantResolutionTier = {
	value: number;
	label: string;
	summary: string;
};

const INSTANT_RESOLUTION_TIERS: InstantResolutionTier[] = [
	{ value: 1280, label: "720p", summary: "Smallest size, low bandwidth." },
	{
		value: 1920,
		label: "1080p",
		summary: "Recommended. Sharp on most networks.",
	},
	{ value: 2560, label: "1440p", summary: "More detail for desktop content." },
	{ value: 3840, label: "4K", summary: "Max clarity. Needs fast upload." },
];

function SegmentedControl<T extends string | number>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<div class="inline-flex p-0.5 rounded-lg border border-gray-3 bg-gray-3">
			<For each={props.options}>
				{(option) => {
					const isSelected = () => props.value === option.value;
					return (
						<button
							type="button"
							onClick={() => props.onChange(option.value)}
							class={cx(
								"px-3 py-1 text-xs font-medium rounded-md transition-all",
								isSelected()
									? "bg-gray-1 text-gray-12 shadow-sm"
									: "text-gray-10 hover:text-gray-12",
							)}
						>
							{option.label}
						</button>
					);
				}}
			</For>
		</div>
	);
}

function StudioQualitySubsection(props: {
	value: StudioRecordingQuality;
	onChange: (value: StudioRecordingQuality) => void;
}) {
	const currentTier = createMemo(
		() =>
			STUDIO_QUALITY_TIERS.find((t) => t.value === props.value) ??
			STUDIO_QUALITY_TIERS[1],
	);

	return (
		<div
			id="settings-section-studio-quality"
			class="flex flex-col gap-3 px-4 py-4"
		>
			<div class="flex justify-between items-start gap-4">
				<div class="flex flex-col gap-0.5 min-w-0">
					<p class="text-[13px] font-medium text-gray-12">Studio mode</p>
					<p class="text-xs leading-snug text-gray-10">
						Encoder profile for local Studio recordings.
					</p>
				</div>
				<SegmentedControl
					value={props.value}
					onChange={props.onChange}
					options={STUDIO_QUALITY_TIERS.map((tier) => ({
						value: tier.value,
						label: tier.label,
					}))}
				/>
			</div>
			<div class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-3">
				<p class="text-xs text-gray-12">{currentTier().summary}</p>
				<p class="text-[11px] text-gray-10 leading-snug">
					<span class="text-gray-11">Best for:</span> {currentTier().bestFor}
				</p>
			</div>
		</div>
	);
}

function InstantQualitySubsection(props: {
	value: number;
	onChange: (value: number) => void;
}) {
	const currentTier = createMemo(
		() =>
			INSTANT_RESOLUTION_TIERS.find((t) => t.value === props.value) ??
			INSTANT_RESOLUTION_TIERS[1],
	);

	return (
		<div
			id="settings-section-instant-quality"
			class="flex flex-col gap-3 px-4 py-4"
		>
			<div class="flex justify-between items-start gap-4">
				<div class="flex flex-col gap-0.5 min-w-0">
					<p class="text-[13px] font-medium text-gray-12">Instant mode</p>
					<p class="text-xs leading-snug text-gray-10">
						Maximum upload resolution for Instant recordings.
					</p>
				</div>
				<SegmentedControl
					value={props.value}
					onChange={props.onChange}
					options={INSTANT_RESOLUTION_TIERS.map((tier) => ({
						value: tier.value,
						label: tier.label,
					}))}
				/>
			</div>
			<div class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-3">
				<p class="text-xs text-gray-12">{currentTier().summary}</p>
			</div>
		</div>
	);
}

function QualitySection(props: {
	studioQuality: StudioRecordingQuality;
	onStudioQualityChange: (value: StudioRecordingQuality) => void;
	instantResolution: number;
	onInstantResolutionChange: (value: number) => void;
}) {
	return (
		<Section
			title="Quality"
			description="Pick the right profile for each recording mode."
		>
			<SectionCard class="divide-y divide-gray-3">
				<StudioQualitySubsection
					value={props.studioQuality}
					onChange={props.onStudioQualityChange}
				/>
				<InstantQualitySubsection
					value={props.instantResolution}
					onChange={props.onInstantResolutionChange}
				/>
			</SectionCard>
		</Section>
	);
}

function Section(
	props: ParentProps<{
		title: string;
		description?: string;
		right?: JSX.Element;
		pro?: boolean;
	}>,
) {
	return (
		<section class="space-y-2.5">
			<header class="flex justify-between items-end gap-3 px-1">
				<div class="flex flex-col gap-0.5 min-w-0">
					<div class="flex gap-2 items-center">
						<h3 class="text-sm font-semibold tracking-tight text-gray-12">
							{props.title}
						</h3>
						<Show when={props.pro}>
							<span class="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-blue-9 text-white">
								Pro
							</span>
						</Show>
					</div>
					<Show when={props.description}>
						<p class="text-xs leading-relaxed text-gray-10">
							{props.description}
						</p>
					</Show>
				</div>
				<Show when={props.right}>
					<div class="flex shrink-0 gap-2 items-center">{props.right}</div>
				</Show>
			</header>
			{props.children}
		</section>
	);
}

function SectionCard(props: ParentProps<{ class?: string; padded?: boolean }>) {
	return (
		<div
			class={cx(
				"overflow-hidden rounded-xl border border-gray-3 bg-gray-2",
				props.padded && "px-4 py-4",
				props.class,
			)}
		>
			{props.children}
		</div>
	);
}

function SectionRows(props: ParentProps) {
	return (
		<SectionCard class="divide-y divide-gray-3">{props.children}</SectionCard>
	);
}

function ServerURLSetting(props: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [value, setValue] = createWritableMemo(() => props.value);

	return (
		<Section
			title="Self-host"
			description="Only change this if you are running your own instance of Cap Web."
		>
			<SectionCard padded>
				<div class="flex flex-col gap-3">
					<label class="flex flex-col gap-1.5">
						<span class="text-[13px] text-gray-12">Cap Server URL</span>
						<Input
							class="bg-gray-3"
							value={value()}
							onInput={(e) => setValue(e.currentTarget.value)}
						/>
					</label>
					<div class="flex justify-end">
						<Button
							size="sm"
							variant="dark"
							disabled={props.value === value()}
							onClick={() => props.onChange(value())}
						>
							Update
						</Button>
					</div>
				</div>
			</SectionCard>
		</Section>
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
				class="px-1.5 py-0.5 mx-0.5 font-mono text-[11px] rounded-md transition-all duration-150 ease-out cursor-pointer bg-gray-3 hover:bg-gray-4 active:scale-95 text-gray-12"
				onClick={() => commands.writeClipboardString(props.children)}
			>
				{props.children}
			</button>
		);
	}

	return (
		<Section
			title="Default project name"
			description="Template used for new recordings and exported files."
			right={
				<>
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
				</>
			}
		>
			<SectionCard padded>
				<div class="flex flex-col gap-3">
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

					<div class="flex gap-2 items-center px-3 py-2 rounded-lg border border-dashed bg-gray-3 border-gray-5">
						<IconCapLogo class="pointer-events-none size-4 shrink-0" />
						<p class="text-xs text-gray-12 whitespace-pre-wrap">{preview()}</p>
					</div>

					<Collapsible class="w-full rounded-lg">
						<Collapsible.Trigger class="inline-flex gap-1 items-center text-xs transition-colors text-gray-10 hover:text-gray-12 group">
							<IconCapChevronDown class="size-3.5 ui-group-expanded:rotate-180 transition-transform duration-200" />
							<span>Available placeholders</span>
						</Collapsible.Trigger>

						<Collapsible.Content class="space-y-3 pt-3 text-xs text-gray-12 opacity-0 transition animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
							<p class="text-gray-10">
								Click any placeholder to copy it. Time supports custom formats
								via <code class="text-gray-12">{"{moment:HH:mm}"}</code>.
							</p>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">Recording mode</p>
								<p>
									<CodeView>{"{recording_mode}"}</CodeView> → "Studio",
									"Instant", or "Screenshot"
								</p>
								<p>
									<CodeView>{"{mode}"}</CodeView> → "studio", "instant", or
									"screenshot"
								</p>
							</div>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">Target</p>
								<p>
									<CodeView>{"{target_kind}"}</CodeView> → "Display", "Window",
									or "Area"
								</p>
								<p>
									<CodeView>{"{target_name}"}</CodeView> → Monitor name or
									window title.
								</p>
							</div>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">Date &amp; time</p>
								<p>
									<CodeView>{"{date}"}</CodeView> → {dateString}
								</p>
								<p>
									<CodeView>{"{time}"}</CodeView> →{" "}
									{macos ? "09:41 AM" : "12:00 PM"}
								</p>
								<p class="flex flex-col items-start pt-1">
									<CodeView>{MOMENT_EXAMPLE_TEMPLATE}</CodeView> →{" "}
									{momentExample()}
								</p>
							</div>
						</Collapsible.Content>
					</Collapsible>
				</div>
			</SectionCard>
		</Section>
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
		<Section
			title="Excluded windows"
			description={
				props.isWindows
					? "Hide windows from recordings. On Windows, only Cap-related windows can be excluded."
					: "Hide windows from recordings."
			}
			right={
				<>
					<Button
						variant="gray"
						size="sm"
						disabled={props.isLoading}
						onClick={() => {
							if (props.isLoading) return;
							void props.onReset();
						}}
					>
						Reset
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={!canAdd()}
						onClick={(e) => void handleAddClick(e)}
						class="flex gap-1.5 items-center"
					>
						<IconLucidePlus class="size-3.5" />
						Add
					</Button>
				</>
			}
		>
			<SectionCard padded>
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
									<div class="flex gap-2 items-center pr-1 pl-3 py-1.5 rounded-full border bg-gray-3 border-gray-4">
										<div class="flex flex-col leading-tight">
											<span class="text-xs text-gray-12">
												{getExclusionPrimaryLabel(entry)}
											</span>
											<Show when={getExclusionSecondaryLabel(entry)}>
												{(label) => (
													<span class="text-[10px] text-gray-9">{label()}</span>
												)}
											</Show>
										</div>
										<button
											type="button"
											class="flex justify-center items-center rounded-full transition-colors size-5 text-gray-10 hover:bg-gray-5 hover:text-gray-12"
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
			</SectionCard>
		</Section>
	);
}

function ExcludedWindowsSkeleton() {
	const chipWidths = ["w-28", "w-24", "w-32"] as const;

	return (
		<div class="flex flex-wrap gap-2" aria-hidden="true">
			<For each={chipWidths}>
				{(width) => (
					<div class="flex gap-2 items-center pr-1 pl-3 py-1.5 rounded-full border bg-gray-3 border-gray-4 animate-pulse">
						<div class="flex flex-col gap-1 leading-tight">
							<div class={cx("h-2.5 rounded-sm bg-gray-4", width)} />
							<div class="w-14 h-2 rounded-sm bg-gray-4" />
						</div>
						<div class="rounded-full size-5 bg-gray-4" />
					</div>
				)}
			</For>
		</div>
	);
}
