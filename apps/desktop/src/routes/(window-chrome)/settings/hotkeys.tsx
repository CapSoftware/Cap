import { createEventListener } from "@solid-primitives/event-listener";
import { batch, createEffect, createResource, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore, hotkeysStore } from "~/store";

import { commands, type Hotkey, type HotkeyAction, type HotkeysStore } from "~/utils/tauri";

const ACTION_TEXT = {
	startStudioRecording: "Start studio recording",
	startInstantRecording: "Start instant recording",
	restartRecording: "Restart recording",
	stopRecording: "Stop recording",
	openRecordingPicker: "Open recording picker",
	openRecordingPickerDisplay: "Record display",
	openRecordingPickerWindow: "Record window",
	openRecordingPickerArea: "Record area",
} satisfies { [K in HotkeyAction]?: string };

export default function () {
	const [store] = createResource(() => hotkeysStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

const MODIFIER_KEYS = new Set(["Meta", "Shift", "Control", "Alt"]);
function Inner(props: { initialStore: HotkeysStore | null }) {
	const generalSettings = generalSettingsStore.createQuery();
	const [hotkeys, setHotkeys] = createStore<{
		[K in HotkeyAction]?: Hotkey;
	}>(props.initialStore?.hotkeys ?? {});

	createEffect(() => {
		hotkeysStore.set({ hotkeys: { ...hotkeys } as any });
	});

	const [listening, setListening] = createSignal<{
		action: HotkeyAction;
		prev?: Hotkey;
	}>();

	createEventListener(window, "keydown", (e) => {
		if (MODIFIER_KEYS.has(e.key)) return;

		const data = {
			code: e.code,
			ctrl: e.ctrlKey,
			shift: e.shiftKey,
			alt: e.altKey,
			meta: e.metaKey,
		};

		const l = listening();
		if (l) {
			e.preventDefault();

			setHotkeys(l.action, data);
		}
	});

	const actions = () =>
		[
			...(generalSettings.data?.enableNewRecordingFlow
				? (["openRecordingPicker"] as const)
				: (["startStudioRecording", "startInstantRecording"] as const)),
			"stopRecording",
			"restartRecording",
			...(generalSettings.data?.enableNewRecordingFlow
				? (["openRecordingPickerDisplay", "openRecordingPickerWindow", "openRecordingPickerArea"] as const)
				: []),
		] satisfies Array<keyof typeof ACTION_TEXT>;

	return (
		<div class="flex flex-col flex-1 h-full custom-scroll">
			{/* <div class="flex flex-col pb-4 border-b border-gray-2">
				<h2 class="text-lg font-medium text-gray-12">Shortcuts</h2>
				<p class="text-sm text-gray-10 w-full max-w-[500px]">
					Configure system-wide keyboard shortcuts to control Cap
				</p>
			</div> */}
			<div
				class="flex flex-col gap-4 p-4 w-full rounded-xl bg-white/5"
				style={{
					"box-shadow": "0 1px 2px 0 rgba(255,255,255,0.05) inset",
				}}
			>
				<Index each={actions()}>
					{(item, idx) => {
						createEventListener(window, "click", () => {
							if (listening()?.action !== item()) return;

							batch(() => {
								setHotkeys(item(), listening()?.prev);
								setListening();
							});
						});

						return (
							<>
								<div class="flex flex-row justify-between items-center w-full h-8">
									<p class="text-sm text-white">{ACTION_TEXT[item()]}</p>
									<Switch>
										<Match when={listening()?.action === item()}>
											<div class="flex flex-row-reverse gap-2 justify-between items-center h-full text-sm rounded-lg w-fit">
												<Show when={hotkeys[item()]} fallback={<p class="text-[13px] text-gray-11">Set hotkeys...</p>}>
													{(binding) => <HotkeyText binding={binding()} />}
												</Show>
												<div class="flex flex-row items-center gap-[0.125rem]">
													<Show when={hotkeys[item()]}>
														<button
															class="w-fit"
															type="button"
															onBlur={(e) => console.log(e)}
															onClick={(e) => {
																e.stopPropagation();

																setListening();
																commands.setHotkey(item(), hotkeys[item()] ?? null);
															}}
														>
															<IconCapCircleCheck class="transition-colors text-white/50 hover:text-white/80 size-5" />
														</button>
													</Show>
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															batch(() => {
																setListening();
																// biome-ignore lint/style/noNonNullAssertion: store
																setHotkeys(item(), undefined!);
																commands.setHotkey(item(), null);
															});
														}}
													>
														<IconCapCircleX class="text-red-500 transition-colors hover:text-red-700 size-5" />
													</button>
												</div>
											</div>
										</Match>
										<Match when={listening()?.action !== item()}>
											<button
												type="button"
												class="text-sm bg-transparent rounded-lg"
												onClick={() => {
													// ensures that previously selected hotkey is cleared by letting the event propagate before listening to the new hotkey
													setTimeout(() => {
														setListening({
															action: item(),
															prev: hotkeys[item()],
														});
													}, 1);
												}}
											>
												<Show
													when={hotkeys[item()]}
													fallback={
														<p
															class="flex items-center text-[14px] transition-colors hover:bg-white/5
                        cursor-pointer px-2.5 h-8 bg-white/[0.03] border border-white/5 rounded-[8px] text-white/50 hover:text-white/80"
														>
															Record Shortcut
														</p>
													}
												>
													{(binding) => <HotkeyText binding={binding()} />}
												</Show>
											</button>
										</Match>
									</Switch>
								</div>
								{idx !== actions().length - 1 && <div class="w-full h-px bg-white/5" />}
							</>
						);
					}}
				</Index>
			</div>
		</div>
	);
}

function HotkeyText(props: { binding: Hotkey }) {
	const keys = [];

	// Add modifier keys
	if (props.binding.meta) keys.push("⌘");
	if (props.binding.ctrl) keys.push("⌃");
	if (props.binding.alt) keys.push("⌥");
	if (props.binding.shift) keys.push("⇧");

	// Add the main key
	const mainKey = props.binding.code.startsWith("Key") ? props.binding.code[3] : props.binding.code;
	keys.push(mainKey);

	return (
		<div class="flex gap-1 items-center w-fit group">
			<For each={keys}>
				{(key) => (
					<kbd class="inline-flex justify-center w-fit text-xs items-center px-3 h-8 text-[13px] font-medium rounded-[8px] border size-6 text-white bg-white/[0.03] border-white/5 group-hover:border-white/10 transition-colors duration-200 group-hover:bg-white/10">
						{key}
					</kbd>
				)}
			</For>
		</div>
	);
}
