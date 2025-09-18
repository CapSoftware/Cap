import { createEventListener } from "@solid-primitives/event-listener";
import {
	batch,
	createEffect,
	createResource,
	createSignal,
	For,
	Index,
	Match,
	Show,
	Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore, hotkeysStore } from "~/store";

import {
	commands,
	type Hotkey,
	type HotkeyAction,
	type HotkeysStore,
} from "~/utils/tauri";

const ACTION_TEXT = {
	startStudioRecording: "Start studio recording",
	startInstantRecording: "Start instant recording",
	restartRecording: "Restart recording",
	stopRecording: "Stop recording",
	// takeScreenshot: "Take Screenshot",
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
				? ([
						"openRecordingPickerDisplay",
						"openRecordingPickerWindow",
						"openRecordingPickerArea",
					] as const)
				: []),
		] satisfies Array<keyof typeof ACTION_TEXT>;

	return (
		<div class="flex flex-col p-4 w-full h-fit">
			<div class="flex flex-col pb-4 border-b border-gray-2">
				<h2 class="text-lg font-medium text-gray-12">Hotkeys</h2>
				<p class="text-sm text-gray-10">
					Configure keyboard shortcuts for common actions.
				</p>
			</div>
			<div class="flex flex-col flex-1 gap-3 p-4 mt-4 w-full rounded-xl border bg-gray-2 border-gray-3">
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
									<p class="text-sm text-gray-12">{ACTION_TEXT[item()]}</p>
									<Switch>
										<Match when={listening()?.action === item()}>
											<div class="flex flex-row-reverse gap-2 justify-between items-center h-full text-sm rounded-lg w-fit">
												<Show
													when={hotkeys[item()]}
													fallback={
														<p class="text-[13px] text-gray-11">
															Set hotkeys...
														</p>
													}
												>
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
																commands.setHotkey(
																	item(),
																	hotkeys[item()] ?? null,
																);
															}}
														>
															<IconCapCircleCheck class="transition-colors text-gray-12 hover:text-gray-10 size-5" />
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
															class="flex items-center text-[11px] uppercase transition-colors hover:bg-gray-6 hover:border-gray-7
                        cursor-pointer py-3 px-2.5 h-5 bg-gray-4 border border-gray-5 rounded-lg text-gray-11 hover:text-gray-12"
														>
															None
														</p>
													}
												>
													{(binding) => <HotkeyText binding={binding()} />}
												</Show>
											</button>
										</Match>
									</Switch>
								</div>
								{idx !== actions().length - 1 && (
									<div class="w-full h-px bg-gray-3" />
								)}
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
	const mainKey = props.binding.code.startsWith("Key")
		? props.binding.code[3]
		: props.binding.code;
	keys.push(mainKey);

	return (
		<div class="flex gap-1 items-center w-fit group">
			<For each={keys}>
				{(key) => (
					<kbd class="inline-flex justify-center w-fit text-xs items-center p-2 text-[13px] font-medium rounded border size-6 text-gray-11 bg-gray-5 border-gray-6 group-hover:border-gray-8 transition-colors duration-200 group-hover:bg-gray-7">
						{key}
					</kbd>
				)}
			</For>
		</div>
	);
}
