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
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import toast from "solid-toast";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { Input } from "~/routes/editor/ui";
import { authStore, generalSettingsStore } from "~/store";
import { clientEnv } from "~/utils/env";
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
	type UpdateChannel,
	type WindowExclusion,
} from "~/utils/tauri";
import IconLucideAlertTriangle from "~icons/lucide/alert-triangle";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";
import {
	Section,
	SectionCard,
	SectionRows,
	SettingItem,
	SettingsPageContent,
	ToggleSettingItem,
} from "./Setting";

const getExclusionPrimaryLabel = (entry: WindowExclusion) =>
	entry.ownerName ?? entry.windowTitle ?? entry.bundleIdentifier ?? "未知";

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

const isSameExclusion = (a: WindowExclusion, b: WindowExclusion) =>
	(a.bundleIdentifier ?? null) === (b.bundleIdentifier ?? null) &&
	(a.ownerName ?? null) === (b.ownerName ?? null) &&
	(a.windowTitle ?? null) === (b.windowTitle ?? null);

const coversDefaultExclusion = (
	entry: WindowExclusion,
	defaultEntry: WindowExclusion,
) => {
	if (isSameExclusion(entry, defaultEntry)) return true;
	if (
		defaultEntry.windowTitle &&
		entry.windowTitle === defaultEntry.windowTitle
	) {
		return true;
	}
	if (
		defaultEntry.bundleIdentifier &&
		entry.bundleIdentifier === defaultEntry.bundleIdentifier
	) {
		return true;
	}
	if (defaultEntry.ownerName && entry.ownerName === defaultEntry.ownerName) {
		return !entry.windowTitle || entry.windowTitle === defaultEntry.windowTitle;
	}
	return false;
};

type ExtendedGeneralSettingsStore = GeneralSettingsStore;

const MAX_FPS_OPTIONS = [
	{ value: 24, label: "24 FPS" },
	{ value: 25, label: "25 FPS" },
	{ value: 30, label: "30 FPS" },
	{ value: 60, label: "60 FPS（推荐）" },
	{ value: 120, label: "120 FPS" },
] satisfies {
	value: number;
	label: string;
}[];

const DEFAULT_PROJECT_NAME_TEMPLATE =
	"{target_name} ({target_kind}) {date} {time}";
const FREE_INSTANT_MODE_MAX_RESOLUTION = 1280;
const PRO_INSTANT_MODE_MAX_RESOLUTION = 1920;

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
		{ id: "system", name: "跟随系统" },
		{ id: "light", name: "浅色" },
		{ id: "dark", name: "深色" },
	] satisfies { id: AppTheme; name: string }[];

	const previews = {
		system: themePreviewAuto,
		light: themePreviewLight,
		dark: themePreviewDark,
	};

	return (
		<Section title="外观" description="让 Cap 跟随系统主题，或选择固定外观。">
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
									aria-label={`选择主题：${theme.name}`}
									onClick={() => props.onThemeChange(theme.id)}
									class="flex flex-col gap-2 items-center group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1 rounded-xl"
								>
									<div
										class={cx(
											"w-full aspect-[5/3] rounded-lg overflow-hidden border-2 transition-[border-color,box-shadow] duration-150",
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
													alt={`${theme.name}主题预览`}
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
	const auth = authStore.createQuery();
	const hasCapPro = createMemo(() => {
		const plan = auth.data?.plan;
		return !!plan && (plan.upgraded || plan.manual);
	});
	const instantModeMaxResolution = createMemo(() =>
		hasCapPro()
			? (settings.instantModeMaxResolution ?? PRO_INSTANT_MODE_MAX_RESOLUTION)
			: FREE_INSTANT_MODE_MAX_RESOLUTION,
	);

	createEffect(() => {
		setSettings(reconcile(deriveGeneralSettings(props.initialStore)));
	});

	let scrollContainerRef: HTMLDivElement | undefined;

	const scrollToSection = (section: string) => {
		try {
			localStorage.removeItem("cap.settings.scrollToSection");
		} catch {}
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
		commands
			.updateAuthPlan()
			.then(() => auth.refetch())
			.catch(console.error);

		let pending: string | null = null;
		try {
			pending = localStorage.getItem("cap.settings.scrollToSection");
		} catch {}
		if (pending) {
			scrollToSection(pending);
		}

		const unlisten = events.requestScrollToSettingsSection.listen((event) => {
			scrollToSection(event.payload.section);
		});
		onCleanup(() => {
			unlisten.then((cb) => cb()).catch(() => {});
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
	const [defaultExcludedWindows] = createResource(
		() => commands.getDefaultExcludedWindows(),
		{
			initialValue: [] as WindowExclusion[],
		},
	);

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
		extra?: Partial<GeneralSettingsStore>,
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		const previousValue = settings[key];
		setSettings(key as keyof GeneralSettingsStore, value);
		try {
			await generalSettingsStore.set({ [key]: value, ...(extra ?? {}) });
		} catch (error) {
			setSettings(key as keyof GeneralSettingsStore, previousValue);
			console.error(`Failed to update ${key}`, error);
		}
	};

	const ostype: OsType = type();
	const excludedWindows = createMemo(() => settings.excludedWindows ?? []);
	const missingDefaultExclusions = createMemo(() =>
		defaultExcludedWindows().filter(
			(defaultEntry) =>
				!excludedWindows().some((entry) =>
					coversDefaultExclusion(entry, defaultEntry),
				),
		),
	);

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
		<div
			ref={scrollContainerRef}
			class="cap-settings-page flex flex-col h-full custom-scroll"
		>
			<SettingsPageContent>
				<AppearanceSection
					currentTheme={settings.theme ?? "system"}
					onThemeChange={(newTheme) => {
						setSettings("theme", newTheme);
						generalSettingsStore.set({ theme: newTheme });
					}}
				/>

				{ostype === "macos" && (
					<Section title="应用" description="选择 Cap 在系统中的显示方式。">
						<SectionRows>
							<ToggleSettingItem
								label="始终显示程序坞图标"
								description="即使没有打开任何窗口，也在程序坞中保留 Cap。"
								value={!settings.hideDockIcon}
								onChange={(v) => handleChange("hideDockIcon", !v)}
							/>
							<ToggleSettingItem
								label="系统通知"
								description="显示复制到剪贴板、文件已保存等通知。你可能需要在系统通知设置中允许 Cap。"
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

				<CapProSection
					hasCapPro={hasCapPro()}
					instantResolution={instantModeMaxResolution()}
					onInstantResolutionChange={(value) =>
						handleChange("instantModeMaxResolution", value)
					}
					autoOpenShareableLinks={!settings.disableAutoOpenLinks}
					onAutoOpenShareableLinksChange={(v) =>
						handleChange("disableAutoOpenLinks", !v)
					}
				/>

				<QualitySection
					studioQuality={settings.studioRecordingQuality ?? "balanced"}
					onStudioQualityChange={(value) =>
						handleChange("studioRecordingQuality", value)
					}
				/>

				<Section title="录制" description="设置录制期间及停止后的行为。">
					<SectionRows>
						<SelectSettingItem
							label="倒计时"
							description="录制开始前的等待时间。"
							value={settings.recordingCountdown ?? 0}
							onChange={(value) => handleChange("recordingCountdown", value)}
							options={[
								{ text: "关闭", value: 0 },
								{ text: "3 秒", value: 3 },
								{ text: "5 秒", value: 5 },
								{ text: "10 秒", value: 10 },
							]}
						/>
						<SelectSettingItem
							label="录制开始时的主窗口"
							description="录制开始后如何处理主窗口。"
							value={settings.mainWindowRecordingStartBehaviour ?? "close"}
							onChange={(value) =>
								handleChange("mainWindowRecordingStartBehaviour", value)
							}
							options={[
								{ text: "关闭", value: "close" },
								{ text: "最小化", value: "minimise" },
							]}
						/>
						<SelectSettingItem
							label="工作室录制结束后"
							description="停止工作室录制后执行的操作。"
							value={settings.postStudioRecordingBehaviour ?? "openEditor"}
							onChange={(value) =>
								handleChange("postStudioRecordingBehaviour", value)
							}
							options={[
								{ text: "打开编辑器", value: "openEditor" },
								{ text: "在悬浮窗中显示", value: "showOverlay" },
							]}
						/>
						<SelectSettingItem
							label="删除录制后"
							description="是否重新打开录制窗口。"
							value={settings.postDeletionBehaviour ?? "doNothing"}
							onChange={(value) => handleChange("postDeletionBehaviour", value)}
							options={[
								{ text: "不执行任何操作", value: "doNothing" },
								{
									text: "重新打开录制窗口",
									value: "reopenRecordingWindow",
								},
							]}
						/>
						<ToggleSettingItem
							label="上传后删除即时录制"
							description="上传成功后，Cap 会移除本地文件。"
							value={settings.deleteInstantRecordingsAfterUpload ?? false}
							onChange={(v) =>
								handleChange("deleteInstantRecordingsAfterUpload", v)
							}
						/>
						<ToggleSettingItem
							label="可从崩溃中恢复的录制"
							description="以分片方式录制，以便在崩溃或断电后恢复。录制期间文件会稍大。"
							value={settings.crashRecoveryRecording ?? true}
							onChange={(value) =>
								handleChange("crashRecoveryRecording", value)
							}
						/>
						<ToggleSettingItem
							label="单独采集光标（工作室）"
							description="单独采集光标状态，以便在编辑器中调整大小和平滑效果。"
							value={!!settings.custom_cursor_capture2}
							onChange={(value) =>
								handleChange("custom_cursor_capture2", value)
							}
						/>
						<ToggleSettingItem
							label="点击时自动缩放"
							description="在工作室录制中围绕鼠标点击位置自动添加缩放片段。"
							value={!!settings.autoZoomOnClicks}
							onChange={(value) => handleChange("autoZoomOnClicks", value)}
						/>
						<ToggleSettingItem
							label="采集键盘按键"
							description="记录按键，以便在编辑器中添加键盘叠加层。"
							value={!!settings.captureKeyboardEvents}
							onChange={(value) => handleChange("captureKeyboardEvents", value)}
						/>
						<SelectSettingItem
							label="最大采集帧率"
							description={
								(settings.maxFps ?? 60) > 60
									? "屏幕采集的最大帧率。较高的值可能在部分系统上导致掉帧或增加 CPU 占用。"
									: "屏幕采集的最大帧率。"
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

				<StorageSection
					recordingsPath={settings.recordingsPath ?? null}
					onPick={async () => {
						try {
							const path = await commands.pickRecordingsFolder();
							if (path !== null) {
								setSettings("recordingsPath", path);
								await offerRecordingsMigration();
							}
						} catch (e) {
							toast.error(
								`选择录制文件夹失败：${e instanceof Error ? e.message : String(e)}`,
							);
						}
					}}
					onReset={async () => {
						try {
							await commands.resetRecordingsFolder();
							setSettings("recordingsPath", null);
							await offerRecordingsMigration();
						} catch (e) {
							toast.error(
								`重置录制文件夹失败：${e instanceof Error ? e.message : String(e)}`,
							);
						}
					}}
				/>

				<DefaultProjectNameCard
					onChange={(value) =>
						handleChange("defaultProjectNameTemplate", value)
					}
					value={settings.defaultProjectNameTemplate ?? null}
				/>

				<ExcludedWindowsCard
					excludedWindows={excludedWindows()}
					missingDefaultExclusions={missingDefaultExclusions()}
					availableWindows={availableWindows()}
					onRequestAvailableWindows={refreshAvailableWindows}
					onRemove={handleRemoveExclusion}
					onAdd={handleAddWindow}
					onReset={handleResetExclusions}
					isLoading={windows.loading}
					isWindows={ostype === "windows"}
				/>

				<UpdatesSection
					value={settings.updateChannel ?? "stable"}
					onChange={async (channel) => {
						await handleChange("updateChannel", channel);
						try {
							await commands.updatesChannelChanged();
						} catch (error) {
							console.error("Failed to notify update channel change", error);
						}
					}}
				/>

				<ServerURLSetting
					value={settings.serverUrl ?? clientEnv.VITE_SERVER_URL}
					defaultValue={clientEnv.VITE_SERVER_URL}
					onChange={async (v) => {
						const url = new URL(v);
						const origin = url.origin;

						if (
							!(await confirm(
								`确定要将服务器 URL 更改为“${origin}”吗？更改后需要重新登录。`,
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
			</SettingsPageContent>
		</div>
	);
}

async function offerRecordingsMigration() {
	let count = 0;
	try {
		count = await commands.countRecordingsToMigrate();
	} catch {
		// Recordings in other folders stay visible in the library either way,
		// so a failed scan just means we don't offer the move.
		return;
	}
	if (count === 0) return;

	const shouldMove = await confirm(
		`将现有的 ${count} 个录制移到新位置吗？无论是否移动，它们都会保留在录制库中。`,
	);
	if (!shouldMove) return;

	const toastId = toast.loading(`正在移动 ${count} 个录制……`);
	let unlisten: (() => void) | undefined;
	try {
		unlisten = await events.recordingsMigrationProgress.listen((e) => {
			toast.loading(
				`正在移动录制…… ${Math.min(e.payload.done + 1, e.payload.total)}/${e.payload.total}`,
				{ id: toastId },
			);
		});

		const summary = await commands.migrateRecordingsToCurrentDir();

		const parts = [`已移动 ${summary.moved} 个录制`];
		if (summary.skippedInUse > 0) {
			parts.push(`${summary.skippedInUse} 个正在使用，已保留在原位置`);
		}
		if (summary.failed.length > 0) {
			parts.push(`${summary.failed.length} 个移动失败，已保留在原文件夹`);
			toast.error(parts.join(" · "), { id: toastId });
		} else {
			toast.success(parts.join(" · "), { id: toastId });
		}
	} catch (e) {
		toast.error(`移动录制失败：${e instanceof Error ? e.message : String(e)}`, {
			id: toastId,
		});
	} finally {
		unlisten?.();
	}
}

function StorageSection(props: {
	recordingsPath: string | null;
	onPick: () => Promise<void>;
	onReset: () => Promise<void>;
}) {
	const defaultLabel = "默认（应用程序支持目录）";
	const displayPath = () => props.recordingsPath ?? defaultLabel;
	const isCustom = () => props.recordingsPath !== null;

	return (
		<Section title="存储" description="Cap 保存录制的位置。">
			<SectionCard padded>
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-3 border border-gray-4 min-w-0">
						<span class="flex-1 text-xs text-gray-12 truncate font-mono">
							{displayPath()}
						</span>
					</div>
					<div class="flex justify-end gap-2">
						<Show when={isCustom()}>
							<Button size="sm" variant="gray" onClick={props.onReset}>
								恢复默认
							</Button>
						</Show>
						<Button size="sm" variant="dark" onClick={props.onPick}>
							选择文件夹
						</Button>
					</div>
				</div>
			</SectionCard>
		</Section>
	);
}

function TelemetryCard(props: {
	value: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<Section title="隐私">
			<SectionRows>
				<ToggleSettingItem
					label="分享匿名遥测数据"
					description="Cap 使用匿名遥测数据来提高可靠性并修复问题。我们绝不会收集录制内容、窗口标题、文件路径或个人信息。"
					value={props.value}
					onChange={props.onChange}
				/>
			</SectionRows>
		</Section>
	);
}

type UpdateChannelOption = {
	value: UpdateChannel;
	label: string;
	description: string;
};

const UPDATE_CHANNEL_OPTIONS: UpdateChannelOption[] = [
	{
		value: "stable",
		label: "稳定版",
		description: "带版本号的正式发布（推荐）",
	},
	{
		value: "nightly",
		label: "每夜版",
		description: "最新构建，会在你未录制或导出时于后台自动更新，可能不稳定。",
	},
];

function UpdatesSection(props: {
	value: UpdateChannel;
	onChange: (value: UpdateChannel) => void;
}) {
	const currentOption = createMemo(
		() =>
			UPDATE_CHANNEL_OPTIONS.find((option) => option.value === props.value) ??
			UPDATE_CHANNEL_OPTIONS[0],
	);

	return (
		<Section title="更新" description="选择要接收的 Cap 构建版本。">
			<SectionCard>
				<div class="flex flex-col gap-3 px-4 py-4">
					<div class="flex justify-between items-start gap-4">
						<div class="flex flex-col gap-0.5 min-w-0">
							<p class="text-[13px] text-gray-12">更新通道</p>
							<p class="text-xs leading-snug text-gray-10">
								Cap 从哪个发布通道获取更新。
							</p>
						</div>
						<SegmentedControl
							value={props.value}
							onChange={props.onChange}
							options={UPDATE_CHANNEL_OPTIONS.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
						/>
					</div>
					<div class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-3">
						<p class="text-xs text-gray-12">{currentOption().description}</p>
						<Show when={props.value === "nightly"}>
							<p class="text-[11px] text-gray-10 leading-snug">
								切回稳定版后将恢复到最新稳定版本，该版本可能比当前构建更旧。
							</p>
						</Show>
					</div>
				</div>
			</SectionCard>
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
		label: "兼容",
		summary: "使用较低码率，让老旧或低性能设备保持流畅。",
		bestFor: "较老的 Intel Mac、8GB MacBook Air 和性能较弱的笔记本电脑。",
	},
	{
		value: "balanced",
		label: "均衡",
		summary: "兼顾清晰画面与合理的 CPU、磁盘占用。",
		bestFor: "大多数配备 16GB 以上内存的新款 Mac 和 PC。",
	},
	{
		value: "ultra",
		label: "极致",
		summary: "保留最多细节，适合调色和大屏编辑。",
		bestFor: "M 系列 Pro/Max、独立显卡、32GB 以上内存和 NVMe 存储。",
	},
];

type InstantResolutionTier = {
	value: number;
	label: string;
	summary: string;
};

const INSTANT_RESOLUTION_TIERS: InstantResolutionTier[] = [
	{ value: 1280, label: "720p", summary: "文件最小，带宽占用低。" },
	{
		value: 1920,
		label: "1080p",
		summary: "推荐。适合大多数网络，画面清晰。",
	},
	{ value: 2560, label: "1440p", summary: "桌面内容细节更多。" },
	{ value: 3840, label: "4K", summary: "清晰度最高，需要较快的上传速度。" },
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
								"px-3 py-1 text-xs font-medium rounded-md transition-[background-color,color,box-shadow]",
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
					<p class="text-[13px] text-gray-12">工作室模式</p>
					<p class="text-xs leading-snug text-gray-10">
						本地工作室录制使用的编码配置。
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
					<span class="text-gray-11">最适合：</span> {currentTier().bestFor}
				</p>
			</div>
		</div>
	);
}

function InstantQualitySetting(props: {
	hasCapPro: boolean;
	value: number;
	onChange: (value: number) => void;
}) {
	const effectiveValue = createMemo(() =>
		props.hasCapPro ? props.value : FREE_INSTANT_MODE_MAX_RESOLUTION,
	);
	const currentTier = createMemo(
		() =>
			INSTANT_RESOLUTION_TIERS.find((t) => t.value === effectiveValue()) ??
			INSTANT_RESOLUTION_TIERS[0],
	);
	const handleResolutionClick = async (value: number) => {
		if (props.hasCapPro || value === FREE_INSTANT_MODE_MAX_RESOLUTION) {
			props.onChange(value);
			return;
		}

		toast.custom(
			(t) => (
				<div class="flex gap-3 items-center px-4 py-3 rounded-xl border shadow-lg bg-gray-1 border-gray-4 text-gray-12">
					<p class="text-sm">
						升级到 Cap Pro，即可录制高于 720p 的即时模式视频。
					</p>
					<button
						type="button"
						class="px-2.5 py-1 text-xs font-medium rounded-lg transition-colors bg-blue-9 text-white hover:bg-blue-10"
						onClick={() => {
							toast.dismiss(t.id);
							void commands.showWindow("Upgrade");
						}}
					>
						升级
					</button>
				</div>
			),
			{ duration: 6000 },
		);
	};

	return (
		<SettingItem
			id="settings-section-instant-quality"
			label="即时模式画质"
			description={
				props.hasCapPro
					? "选择即时录制的最大上传分辨率。"
					: "即时录制固定为 720p。Cap Pro 可解锁更高分辨率。"
			}
		>
			<div class="flex flex-col items-end gap-1.5">
				<div class="inline-flex p-0.5 rounded-lg border border-gray-3 bg-gray-3">
					<For each={INSTANT_RESOLUTION_TIERS}>
						{(tier) => {
							const isSelected = () => effectiveValue() === tier.value;
							return (
								<button
									type="button"
									onClick={() => void handleResolutionClick(tier.value)}
									class={cx(
										"px-3 py-1 text-xs font-medium rounded-md transition-[background-color,color,box-shadow]",
										isSelected()
											? "bg-gray-1 text-gray-12 shadow-sm"
											: "text-gray-10 hover:text-gray-12",
									)}
								>
									{tier.label}
								</button>
							);
						}}
					</For>
				</div>
				<p class="text-[11px] leading-snug text-right text-gray-10">
					{currentTier().summary}
				</p>
			</div>
		</SettingItem>
	);
}

function CapProSection(props: {
	hasCapPro: boolean;
	instantResolution: number;
	onInstantResolutionChange: (value: number) => void;
	autoOpenShareableLinks: boolean;
	onAutoOpenShareableLinksChange: (value: boolean) => void;
}) {
	return (
		<Section title="Cap Pro" description="Cap Pro 许可证可用的设置。" pro>
			<SectionRows>
				<InstantQualitySetting
					hasCapPro={props.hasCapPro}
					value={props.instantResolution}
					onChange={props.onInstantResolutionChange}
				/>
				<ToggleSettingItem
					label="自动打开分享链接"
					description="上传完成后立即在浏览器中打开分享链接。"
					value={props.autoOpenShareableLinks}
					onChange={props.onAutoOpenShareableLinksChange}
				/>
			</SectionRows>
		</Section>
	);
}

function QualitySection(props: {
	studioQuality: StudioRecordingQuality;
	onStudioQualityChange: (value: StudioRecordingQuality) => void;
}) {
	return (
		<Section title="画质" description="为本地工作室录制选择合适的配置。">
			<SectionCard>
				<StudioQualitySubsection
					value={props.studioQuality}
					onChange={props.onStudioQualityChange}
				/>
			</SectionCard>
		</Section>
	);
}

function ServerURLSetting(props: {
	value: string;
	defaultValue: string;
	onChange: (v: string) => void;
}) {
	const [value, setValue] = createWritableMemo(() => props.value);
	const isDefaultValue = () =>
		props.value === props.defaultValue && value() === props.defaultValue;
	const resetToDefault = () => {
		if (props.value === props.defaultValue) {
			setValue(props.defaultValue);
			return;
		}

		props.onChange(props.defaultValue);
	};

	return (
		<Section
			title="自托管"
			description="仅在运行自己的 Cap Web 实例时更改此项。"
		>
			<SectionCard padded>
				<div class="flex flex-col gap-3">
					<label class="flex flex-col gap-1.5">
						<span class="text-[13px] text-gray-12">Cap 服务器地址</span>
						<Input
							class="bg-gray-3"
							value={value()}
							onInput={(e) => setValue(e.currentTarget.value)}
						/>
					</label>
					<div class="flex justify-end gap-2">
						<Button
							size="sm"
							variant="gray"
							disabled={isDefaultValue()}
							onClick={resetToDefault}
						>
							恢复默认
						</Button>
						<Button
							size="sm"
							variant="dark"
							disabled={props.value === value()}
							onClick={() => props.onChange(value())}
						>
							更新
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
				title="点击复制"
				class="px-1.5 py-0.5 mx-0.5 font-mono text-[11px] rounded-md transition-[background-color,color,transform] duration-150 ease-out bg-gray-3 hover:bg-gray-4 active:scale-95 text-gray-12"
				onClick={() => commands.writeClipboardString(props.children)}
			>
				{props.children}
			</button>
		);
	}

	return (
		<Section
			title="默认项目名称"
			description="新录制和导出文件使用的命名模板。"
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
						重置
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
						保存
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
							<IconCapChevronDown class="size-3.5 data-group-expanded:rotate-180 transition-transform duration-200" />
							<span>可用占位符</span>
						</Collapsible.Trigger>

						<Collapsible.Content class="space-y-3 pt-3 text-xs text-gray-12 opacity-0 transition animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
							<p class="text-gray-10">
								点击任意占位符即可复制。时间支持通过{" "}
								<code class="text-gray-12">{"{moment:HH:mm}"}</code>{" "}
								自定义格式。
							</p>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">录制模式</p>
								<p>
									<CodeView>{"{recording_mode}"}</CodeView> → “工作室”、
									“即时”或“截图”
								</p>
								<p>
									<CodeView>{"{mode}"}</CodeView> → “studio”、“instant”或
									“screenshot”
								</p>
							</div>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">目标</p>
								<p>
									<CodeView>{"{target_kind}"}</CodeView> → “显示器”、“窗口”
									或“区域”
								</p>
								<p>
									<CodeView>{"{target_name}"}</CodeView> →
									显示器名称或窗口标题。
								</p>
							</div>

							<div class="space-y-1">
								<p class="font-medium text-gray-12">日期和时间</p>
								<p>
									<CodeView>{"{date}"}</CodeView> → {dateString}
								</p>
								<p>
									<CodeView>{"{time}"}</CodeView> → {macos ? "09:41" : "12:00"}
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
	missingDefaultExclusions: WindowExclusion[];
	availableWindows: CaptureWindow[];
	onRequestAvailableWindows: () => Promise<CaptureWindow[]>;
	onRemove: (index: number) => Promise<void>;
	onAdd: (window: CaptureWindow) => Promise<void>;
	onReset: () => Promise<void>;
	isLoading: boolean;
	isWindows: boolean;
}) {
	const hasExclusions = () => props.excludedWindows.length > 0;
	const hasMissingDefaultExclusions = () =>
		props.missingDefaultExclusions.length > 0;
	const missingDefaultLabels = () =>
		props.missingDefaultExclusions.map(getExclusionPrimaryLabel).join(", ");
	const canAdd = () => !props.isLoading;
	const handleResetClick = () => {
		if (props.isLoading) return;
		void props.onReset();
	};

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
			title="排除的窗口"
			description={
				props.isWindows
					? "在录制中隐藏窗口。在 Windows 上，只能排除与 Cap 相关的窗口。"
					: "在录制中隐藏窗口。"
			}
			right={
				<>
					<Button
						variant="gray"
						size="sm"
						disabled={props.isLoading}
						onClick={handleResetClick}
					>
						重置
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={!canAdd()}
						onClick={(e) => void handleAddClick(e)}
						class="flex gap-1.5 items-center"
					>
						<IconLucidePlus class="size-3.5" />
						添加
					</Button>
				</>
			}
		>
			<SectionCard padded>
				<Show when={hasMissingDefaultExclusions()}>
					<div class="mb-3 rounded-lg border border-amber-6 bg-amber-3/30 px-3 py-2.5">
						<div class="flex items-start gap-2">
							<IconLucideAlertTriangle class="mt-0.5 size-4 shrink-0 text-amber-11" />
							<div class="min-w-0 flex-1 space-y-1">
								<p class="text-xs font-medium text-amber-11">
									尚未排除建议隐藏的 Cap 窗口
								</p>
								<p class="text-[10px] leading-snug text-amber-11">
									摄像头、设置或录制窗口可能会在屏幕录制中显示为黑框。 尚缺：
									{missingDefaultLabels()}。
								</p>
							</div>
							<Button
								variant="gray"
								size="sm"
								disabled={props.isLoading}
								onClick={handleResetClick}
								class="shrink-0"
							>
								恢复
							</Button>
						</div>
					</div>
				</Show>
				<Show when={!props.isLoading} fallback={<ExcludedWindowsSkeleton />}>
					<Show
						when={hasExclusions()}
						fallback={<p class="text-xs text-gray-10">当前未排除任何窗口。</p>}
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
											aria-label="移除排除的窗口"
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
