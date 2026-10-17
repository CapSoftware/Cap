import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import {
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import toast from "solid-toast";
import { authStore, generalSettingsStore } from "~/store";
import {
	deriveGeneralSettings,
	type GeneralSettingsStore,
} from "~/utils/general-settings";
import { openPricingPage } from "~/utils/pricing";
import { commands, events, type StudioRecordingQuality } from "~/utils/tauri";
import {
	Section,
	SectionCard,
	SectionRows,
	SettingsPageContent,
	ToggleSettingItem,
} from "./Setting";

const STUDIO_OPTIONS = [
	{
		value: "balanced",
		label: "均衡",
		description:
			"画面清晰、细节丰富，文件体积适中。适合日常使用。",
	},
	{
		value: "compatibility",
		label: "更小的文件",
		description:
			"占用磁盘更少。可能降低细节，尤其是带摄像头录制时。",
	},
	{
		value: "ultra",
		label: "最高细节",
		description:
			"为繁重的剪辑保留更多细节，文件更大，也需要更多磁盘空间。",
	},
] satisfies {
	value: StudioRecordingQuality;
	label: string;
	description: string;
}[];

const INSTANT_OPTIONS = [
	{
		value: 1280,
		label: "720p",
		description: "上传体积更小，适合快速更新。",
	},
	{
		value: 1920,
		label: "1080p",
		description:
			"文字清晰，上传体积适中。推荐配合 Cap 专业版使用。",
	},
	{
		value: 2560,
		label: "1440p",
		description: "为更大屏幕保留更多细节，上传耗时更长。",
	},
	{
		value: 3840,
		label: "4K",
		description:
			"细节最丰富，上传体积最大。建议使用高速网络。",
	},
];

export default function RecordingQualitySettings() {
	const store = generalSettingsStore.createQuery();
	const auth = authStore.createQuery();
	const settings = createMemo(() => deriveGeneralSettings(store.data));
	const studioQuality = createMemo(
		() => settings().studioRecordingQuality ?? "balanced",
	);
	const hasCapPro = createMemo(
		() => !!(auth.data?.plan?.upgraded || auth.data?.plan?.manual),
	);
	const [saving, setSaving] = createSignal(false);
	const instantResolution = createMemo(() =>
		hasCapPro() ? (settings().instantModeMaxResolution ?? 1920) : 1280,
	);
	const instantDescription = createMemo(
		() =>
			INSTANT_OPTIONS.find((option) => option.value === instantResolution())
				?.description,
	);
	let scrollContainer: HTMLDivElement | undefined;
	let scrollTimer: ReturnType<typeof setTimeout> | undefined;

	const scrollToSection = (section: string) => {
		if (section !== "studio-quality" && section !== "instant-quality") return;
		clearTimeout(scrollTimer);
		const attempt = (remaining: number) => {
			const target = document.getElementById(`settings-section-${section}`);
			if (!target || !scrollContainer) {
				if (remaining > 0)
					scrollTimer = setTimeout(() => attempt(remaining - 1), 50);
				return;
			}
			scrollContainer.scrollTo({
				top:
					target.getBoundingClientRect().top -
					scrollContainer.getBoundingClientRect().top +
					scrollContainer.scrollTop -
					16,
				behavior: "smooth",
			});
		};
		attempt(10);
	};

	onMount(() => {
		commands
			.updateAuthPlan()
			.then(() => auth.refetch())
			.catch(console.error);
		try {
			const section = localStorage.getItem("cap.settings.scrollToSection");
			localStorage.removeItem("cap.settings.scrollToSection");
			if (section) scrollToSection(section);
		} catch {}
		const unlisten = events.requestScrollToSettingsSection.listen((event) =>
			scrollToSection(event.payload.section),
		);
		onCleanup(() => {
			clearTimeout(scrollTimer);
			unlisten.then((cleanup) => cleanup()).catch(console.error);
		});
	});

	const save = async <K extends keyof GeneralSettingsStore>(
		key: K,
		value: GeneralSettingsStore[K],
	) => {
		if (saving()) return;
		setSaving(true);
		try {
			await generalSettingsStore.set({ [key]: value });
			await store.refetch();
		} catch {
			toast.error("无法保存你的录制设置，请重试。");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div
			ref={scrollContainer}
			class="cap-settings-page h-full overflow-y-auto custom-scroll"
		>
			<SettingsPageContent>
				<Section
					title="录制画质"
					description="选择新录制的画质与占用空间。"
				/>
				<Show when={store.isPending}>
					<p class="text-xs text-gray-10">正在加载录制设置…</p>
				</Show>
				<Show when={store.isError}>
					<SectionCard padded>
						<p class="mb-3 text-xs text-gray-10">
							无法加载你的录制设置。
						</p>
						<Button
							size="sm"
							variant="gray"
							onClick={() => void store.refetch()}
						>
							重试
						</Button>
					</SectionCard>
				</Show>
				<Show when={!store.isPending && !store.isError}>
					<div id="settings-section-studio-quality">
						<Section
							title="Studio"
							description="已保存到你的电脑，随时可以编辑。三档画质在所有版本中都可用。"
						>
							<SectionCard padded>
								<div
									class="flex flex-col gap-2"
									role="group"
									aria-label="Studio 录制画质"
								>
									<For each={STUDIO_OPTIONS}>
										{(option) => (
											<button
												type="button"
												aria-pressed={studioQuality() === option.value}
												disabled={saving()}
												onClick={() =>
													void save("studioRecordingQuality", option.value)
												}
												class={cx(
													"flex items-start gap-3 p-3 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-60",
													studioQuality() === option.value
														? "border-blue-9 bg-blue-3"
														: "border-gray-4 hover:bg-gray-3",
												)}
											>
												<span
													class={cx(
														"mt-0.5 size-4 shrink-0 rounded-full border flex items-center justify-center",
														studioQuality() === option.value
															? "border-blue-9"
															: "border-gray-7",
													)}
												>
													<Show when={studioQuality() === option.value}>
														<span class="size-2 rounded-full bg-blue-9" />
													</Show>
												</span>
												<span class="flex flex-col gap-1">
													<span class="flex items-center gap-2 text-[13px] font-medium text-gray-12">
														{option.label}
														<Show when={option.value === "balanced"}>
															<span class="rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-11 bg-blue-4">
																推荐
															</span>
														</Show>
													</span>
													<span class="text-xs leading-relaxed text-gray-10">
														{option.description}
													</span>
												</span>
											</button>
										)}
									</For>
								</div>
								<p class="mt-3 text-xs leading-relaxed text-gray-10">
									这些选项影响原始录制。最终导出的分辨率和文件大小请在编辑器中选择。
								</p>
							</SectionCard>
						</Section>
					</div>
					<div id="settings-section-instant-quality">
						<Section
							title="Instant"
							description="录制的同时就在上传，停止时分享链接已就绪。"
						>
							<SectionCard padded>
								<p class="mb-3 text-[13px] font-medium text-gray-12">
									最大分辨率
								</p>
								<div
									class="grid grid-cols-4 gap-2"
									role="group"
									aria-label="Instant 录制分辨率"
								>
									<For each={INSTANT_OPTIONS}>
										{(option) => (
											<button
												type="button"
												aria-pressed={instantResolution() === option.value}
												disabled={
													saving() ||
													auth.isPending ||
													(!hasCapPro() && option.value > 1280)
												}
												onClick={() =>
													void save("instantModeMaxResolution", option.value)
												}
												class={cx(
													"flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:cursor-default",
													instantResolution() === option.value
														? "border-blue-9 bg-blue-3 text-gray-12"
														: "border-gray-4 text-gray-10 enabled:hover:bg-gray-3",
												)}
											>
												{option.label}
												<Show when={!hasCapPro() && option.value > 1280}>
													<span class="text-[9px] text-gray-10">专业版</span>
												</Show>
											</button>
										)}
									</For>
								</div>
								<p class="mt-3 text-xs leading-relaxed text-gray-10">
									{instantDescription()} 分辨率受你所录制的屏幕或区域限制。
								</p>
								<Show when={!auth.isPending && !hasCapPro()}>
									<div class="flex flex-col items-start gap-3 mt-4 pt-4 border-t border-gray-4">
										<p class="text-xs leading-relaxed text-gray-11">
											默认包含 720p。Cap 专业版可为 Instant 录制解锁 1080p、1440p 和 4K。
										</p>
										<Button
											size="sm"
											variant="gray"
											onClick={() => void openPricingPage()}
										>
											View plans ↗
										</Button>
									</div>
								</Show>
							</SectionCard>
						</Section>
					</div>
					<Section title="分享">
						<SectionRows>
							<ToggleSettingItem
								label="自动打开分享链接"
								description="上传完成后在浏览器中打开链接。"
								value={!settings().disableAutoOpenLinks}
								onChange={(value) => void save("disableAutoOpenLinks", !value)}
							/>
						</SectionRows>
					</Section>
				</Show>
			</SettingsPageContent>
		</div>
	);
}
