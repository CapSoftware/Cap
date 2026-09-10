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
		label: "Balanced",
		description:
			"Clear, detailed recordings with a practical file size. Best for everyday use.",
	},
	{
		value: "compatibility",
		label: "Smaller files",
		description:
			"Uses less disk space. Can reduce detail, especially when recording with a camera.",
	},
	{
		value: "ultra",
		label: "Maximum detail",
		description:
			"Preserves more detail for demanding edits. Creates larger files and needs more disk space.",
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
		description: "Smaller uploads. Good for quick updates.",
	},
	{
		value: 1920,
		label: "1080p",
		description:
			"Clear text and a practical upload size. Recommended with Cap Pro.",
	},
	{
		value: 2560,
		label: "1440p",
		description: "More detail for larger screens. Takes longer to upload.",
	},
	{
		value: 3840,
		label: "4K",
		description:
			"The most detail and largest uploads. Best with a fast connection.",
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
			toast.error("Couldn't save your recording settings. Please try again.");
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
					title="Recording quality"
					description="Choose how new recordings look and how much space they use."
				/>
				<Show when={store.isPending}>
					<p class="text-xs text-gray-10">Loading recording settings…</p>
				</Show>
				<Show when={store.isError}>
					<SectionCard padded>
						<p class="mb-3 text-xs text-gray-10">
							Couldn't load your recording settings.
						</p>
						<Button
							size="sm"
							variant="gray"
							onClick={() => void store.refetch()}
						>
							Try again
						</Button>
					</SectionCard>
				</Show>
				<Show when={!store.isPending && !store.isError}>
					<div id="settings-section-studio-quality">
						<Section
							title="Studio"
							description="Saved to your computer, ready to edit. All three quality options are available on every plan."
						>
							<SectionCard padded>
								<div
									class="flex flex-col gap-2"
									role="group"
									aria-label="Studio recording quality"
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
																Recommended
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
									These options affect the original recording. Choose your final
									export resolution and file size in the editor.
								</p>
							</SectionCard>
						</Section>
					</div>
					<div id="settings-section-instant-quality">
						<Section
							title="Instant"
							description="Uploads while you record, so your share link is ready when you stop."
						>
							<SectionCard padded>
								<p class="mb-3 text-[13px] font-medium text-gray-12">
									Maximum resolution
								</p>
								<div
									class="grid grid-cols-4 gap-2"
									role="group"
									aria-label="Instant recording resolution"
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
													<span class="text-[9px] text-gray-10">Pro</span>
												</Show>
											</button>
										)}
									</For>
								</div>
								<p class="mt-3 text-xs leading-relaxed text-gray-10">
									{instantDescription()} Resolution is limited by the screen or
									area you record.
								</p>
								<Show when={!auth.isPending && !hasCapPro()}>
									<div class="flex flex-col items-start gap-3 mt-4 pt-4 border-t border-gray-4">
										<p class="text-xs leading-relaxed text-gray-11">
											720p is included. Cap Pro unlocks 1080p, 1440p and 4K for
											Instant recordings.
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
					<Section title="Sharing">
						<SectionRows>
							<ToggleSettingItem
								label="Open share links automatically"
								description="Open the link in your browser when an upload finishes."
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
