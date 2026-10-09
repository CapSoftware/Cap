import { Button } from "@cap/ui-solid";
import { invoke } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import {
	deriveGeneralSettings,
	type GeneralSettingsStore,
} from "~/utils/general-settings";
import {
	Section,
	SectionRows,
	SettingItem,
	SettingsPageContent,
	ToggleSettingItem,
} from "./Setting";

// The explainer runs alongside the countdown rather than before it: the numeral
// is on screen from the first frame, and the lines fade through underneath it.
// The mirror of this sequence lives in `render_switch_overlay` in the native
// app's `settings_pages.rs`.
const SWITCH_SENTENCES = [
	"Switching to Cap.",
	"Same Cap, rebuilt fully native for performance.",
	"Your recordings and settings come with you.",
];
const CAP_DOWNLOAD_URL = "https://cap.so/download";
const SENTENCE_MS = 1300;
const COUNTDOWN_FROM = 5;

type Takeover = {
	sentence: number;
	/** Counts 5 down to 1; the switch fires rather than ever showing zero. */
	remaining: number;
	/** Set when the switch was refused; the overlay stays up with the reason. */
	error: string | null;
};

export default function ExperimentalSettings() {
	const [store] = createResource(() => generalSettingsStore.get());
	const osType = type();

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} osType={osType} />}
		</Show>
	);
}

function Inner(props: {
	initialStore: GeneralSettingsStore | null;
	osType: ReturnType<typeof type>;
}) {
	const [settings, setSettings] = createStore<GeneralSettingsStore>(
		deriveGeneralSettings(props.initialStore),
	);

	const [capInstalled] = createResource(() =>
		invoke<boolean>("gpui_app_available").catch(() => false),
	);

	const [takeover, setTakeover] = createSignal<Takeover | null>(null);
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const clearTimers = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};
	onCleanup(clearTimers);

	const cancelTakeover = () => {
		clearTimers();
		setTakeover(null);
	};

	const performSwitch = async () => {
		try {
			await invoke("switch_to_gpui_app");
		} catch (error) {
			setTakeover((state) =>
				state
					? {
							...state,
							error: typeof error === "string" ? error : "Couldn't open Cap.",
						}
					: state,
			);
		}
	};

	const startTakeover = () => {
		clearTimers();
		setTakeover({ sentence: 0, remaining: COUNTDOWN_FROM, error: null });

		for (let index = 1; index < SWITCH_SENTENCES.length; index += 1) {
			timers.add(
				setTimeout(() => {
					setTakeover((state) =>
						state ? { ...state, sentence: index } : state,
					);
				}, index * SENTENCE_MS),
			);
		}

		for (let tick = 1; tick < COUNTDOWN_FROM; tick += 1) {
			timers.add(
				setTimeout(() => {
					setTakeover((state) =>
						state ? { ...state, remaining: COUNTDOWN_FROM - tick } : state,
					);
				}, tick * 1000),
			);
		}

		timers.add(setTimeout(() => void performSwitch(), COUNTDOWN_FROM * 1000));
	};

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		const previousValue = settings[key];
		setSettings(key as keyof GeneralSettingsStore, value);
		try {
			if (key === "enableNativeCameraPreview") {
				await invoke("set_native_camera_preview_enabled", { enabled: value });
				await generalSettingsStore.set({ [key]: value });
			} else {
				await generalSettingsStore.set({ [key]: value });
			}
		} catch (error) {
			setSettings(key as keyof GeneralSettingsStore, previousValue);
			console.error(`Failed to update ${key}`, error);
		}
	};

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Show when={props.osType === "macos"}>
					<Section title="Preview">
						<SectionRows>
							<ToggleSettingItem
								label="Native camera preview"
								description="Render the camera preview using a native GPU surface instead of through the webview. Experimental and off by default."
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						</SectionRows>
					</Section>
				</Show>

				<Section title="Reliability">
					<SectionRows>
						<ToggleSettingItem
							label="Out-of-process muxer"
							description="Run the fragmented-MP4 muxer in an isolated subprocess so muxer crashes can't take down your recording. Requires the bundled cap-muxer binary."
							value={!!settings.outOfProcessMuxer}
							onChange={(value) => handleChange("outOfProcessMuxer", value)}
						/>
					</SectionRows>
				</Section>

				<Section title="Cap">
					<SectionRows>
						<SettingItem
							label="Switch to Cap"
							description={
								capInstalled()
									? "Close Cap Classic and open Cap, the fully native version. Your recordings and settings are shared, and you can come back from Cap's Experimental settings."
									: "Cap, the fully native version, isn't installed on this computer yet. Download it to switch; your recordings and settings are shared."
							}
						>
							<Show
								when={capInstalled()}
								fallback={
									<Button
										size="sm"
										variant="dark"
										onClick={() => void shell.open(CAP_DOWNLOAD_URL)}
									>
										Download
									</Button>
								}
							>
								<Button
									size="sm"
									variant="dark"
									disabled={takeover() !== null}
									onClick={startTakeover}
								>
									Switch
								</Button>
							</Show>
						</SettingItem>
					</SectionRows>
				</Section>
			</SettingsPageContent>

			<Show when={takeover()}>
				{(state) => (
					<div class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black/90 px-10 text-white">
						<Show when={!state().error}>
							<p class="text-8xl font-semibold tabular-nums leading-none text-white">
								{state().remaining}
							</p>
						</Show>

						<div class="relative h-12 w-full max-w-md">
							<For each={SWITCH_SENTENCES}>
								{(sentence, index) => (
									<p
										class="absolute inset-0 flex items-center justify-center text-center text-base text-white transition-opacity duration-500"
										classList={{
											"opacity-100":
												!state().error && index() === state().sentence,
											"opacity-0":
												!!state().error || index() !== state().sentence,
										}}
									>
										{sentence}
									</p>
								)}
							</For>
						</div>

						<Show when={state().error}>
							{(message) => (
								<div
									role="alert"
									class="max-w-md text-center text-sm text-red-400"
								>
									{message()}
								</div>
							)}
						</Show>

						<button
							type="button"
							class="rounded-lg border border-white/25 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10"
							onClick={cancelTakeover}
						>
							Cancel
						</button>
					</div>
				)}
			</Show>
		</div>
	);
}
