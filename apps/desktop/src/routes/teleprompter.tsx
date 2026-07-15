import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";

import { Toggle } from "~/components/Toggle";
import CaptionControlsMacOS from "~/components/titlebar/controls/CaptionControlsMacOS";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import {
	type TeleprompterStore,
	teleprompterDefaults,
	teleprompterStore,
} from "~/store";
import { applyMacOSWindowMaterial } from "~/utils/macos-window-material";
import { commands } from "~/utils/tauri";
import { initializeTitlebar } from "~/utils/titlebar-state";
import IconLucideChevronLeft from "~icons/lucide/chevron-left";
import IconLucideChevronRight from "~icons/lucide/chevron-right";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideFlipHorizontal2 from "~icons/lucide/flip-horizontal-2";
import IconLucideGauge from "~icons/lucide/gauge";
import IconLucideLayers from "~icons/lucide/layers";
import IconLucideMinus from "~icons/lucide/minus";
import IconLucidePause from "~icons/lucide/pause";
import IconLucidePlay from "~icons/lucide/play";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideSettings2 from "~icons/lucide/settings-2";
import {
	advancePlaybackPosition,
	calculatePlaybackSpeed,
	clamp,
	countWords,
} from "./teleprompter-utils";

function ToolButton(props: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: JSX.Element;
}) {
	return (
		<button
			type="button"
			title={props.label}
			aria-label={props.label}
			disabled={props.disabled}
			onClick={props.onClick}
			class={cx(
				"flex size-7 items-center justify-center rounded-full text-gray-9 transition hover:bg-gray-12/7 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-30",
				props.active && "bg-gray-12/8 text-gray-12",
			)}
		>
			{props.children}
		</button>
	);
}

function SettingToggle(props: {
	label: string;
	active: boolean;
	onChange: (active: boolean) => void;
	children: JSX.Element;
}) {
	return (
		<div class="flex items-center justify-between px-2 py-2 text-xs text-gray-10">
			<span class="flex items-center gap-2">
				{props.children}
				{props.label}
			</span>
			<Toggle
				size="sm"
				checked={props.active}
				onChange={props.onChange}
				aria-label={props.label}
			/>
		</div>
	);
}

export default function Teleprompter() {
	const currentWindow = getCurrentWebviewWindow();
	const platform = ostype();
	const isMacOS = platform === "macos";
	const isWindows = platform === "windows";
	const isLinux = platform === "linux";
	const [state, setState] =
		createSignal<TeleprompterStore>(teleprompterDefaults);
	const [isLoaded, setIsLoaded] = createSignal(false);
	const [isPlaying, setIsPlaying] = createSignal(false);
	const [settingsOpen, setSettingsOpen] = createSignal(false);
	let scrollElement: HTMLDivElement | undefined;
	let editorElement: HTMLTextAreaElement | undefined;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let unlistenTitlebar: UnlistenFn | undefined;
	let unlistenCloseRequested: UnlistenFn | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let playbackFrame = 0;
	let playbackPosition = 0;
	let playbackTimestamp: number | undefined;
	let allowClose = false;
	let closePending = false;
	let disposed = false;

	const hasScript = createMemo(() => state().script.trim().length > 0);
	const wordCount = createMemo(() => countWords(state().script));
	const spacerHeight = createMemo(
		() =>
			`calc((100vh - 5rem) / 2 - ${state().fontSize * state().lineHeight * 0.5}px)`,
	);

	onMount(() => {
		document.documentElement.setAttribute("data-transparent-window", "true");
		document.body.style.background = "transparent";

		void Promise.allSettled([
			applyMacOSWindowMaterial("teleprompter"),
			initializeTitlebar().then((unlisten) => {
				unlistenTitlebar = unlisten;
			}),
		])
			.then(async () => {
				await commands.setTeleprompterWindowLevel(true);
				await currentWindow.show();
				await currentWindow.setFocus();
			})
			.catch((error) => {
				console.error("Failed to show teleprompter window:", error);
			});

		void teleprompterStore
			.get()
			.then((saved) => {
				if (saved) setState({ ...teleprompterDefaults, ...saved });
				setIsLoaded(true);
				requestAnimationFrame(resizeEditor);
			})
			.catch((error) => {
				console.error("Failed to load teleprompter settings:", error);
				setIsLoaded(true);
				requestAnimationFrame(resizeEditor);
			});

		if (scrollElement) {
			resizeObserver = new ResizeObserver(resizeEditor);
			resizeObserver.observe(scrollElement);
		}
	});

	onMount(() => {
		void currentWindow
			.onCloseRequested(async (event) => {
				if (allowClose) return;
				event.preventDefault();
				if (closePending) return;

				closePending = true;
				clearTimeout(saveTimer);
				try {
					if (isLoaded()) await teleprompterStore.set(state());
				} catch (error) {
					console.error("Failed to save teleprompter before closing:", error);
				} finally {
					allowClose = true;
					await currentWindow.close();
				}
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else unlistenCloseRequested = unlisten;
			})
			.catch((error) => {
				console.error("Failed to register teleprompter close handler:", error);
			});
	});

	createEffect(() => {
		if (!isLoaded()) return;
		const nextState = state();
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void teleprompterStore.set(nextState);
		}, 250);
	});

	createEffect(() => {
		if (!isLoaded() || !isMacOS) return;
		const opacity = clamp(state().windowOpacityPercent, 45, 100) / 100;
		void commands.setTeleprompterWindowOpacity(opacity).catch((error) => {
			console.error("Failed to update teleprompter window opacity:", error);
		});
	});

	onCleanup(() => {
		disposed = true;
		if (isLoaded() && !allowClose) void teleprompterStore.set(state());
		clearTimeout(saveTimer);
		cancelAnimationFrame(playbackFrame);
		resizeObserver?.disconnect();
		unlistenTitlebar?.();
		unlistenCloseRequested?.();
	});

	function resizeEditor() {
		const element = editorElement;
		if (!element) return;
		element.style.height = "0px";
		element.style.height = `${element.scrollHeight}px`;
	}

	function stopPlayback() {
		cancelAnimationFrame(playbackFrame);
		playbackFrame = 0;
		playbackTimestamp = undefined;
		setIsPlaying(false);
	}

	function animatePlayback(timestamp: number) {
		const element = scrollElement;
		if (!element) {
			stopPlayback();
			return;
		}

		const maximumScroll = Math.max(
			0,
			element.scrollHeight - element.clientHeight,
		);
		if (maximumScroll <= 1) {
			stopPlayback();
			return;
		}

		const elapsedSeconds =
			playbackTimestamp === undefined
				? 0
				: Math.min((timestamp - playbackTimestamp) / 1000, 0.05);
		playbackTimestamp = timestamp;
		playbackPosition = advancePlaybackPosition(
			playbackPosition,
			maximumScroll,
			calculatePlaybackSpeed(
				maximumScroll,
				wordCount(),
				state().wordsPerMinute,
			),
			elapsedSeconds,
		);
		element.scrollTop = playbackPosition;

		if (playbackPosition >= maximumScroll - 0.5) {
			stopPlayback();
			return;
		}

		playbackFrame = requestAnimationFrame(animatePlayback);
	}

	function updateScript(value: string) {
		setState((current) => ({ ...current, script: value }));
		if (!value.trim()) stopPlayback();
		requestAnimationFrame(resizeEditor);
	}

	function togglePlayback() {
		if (isPlaying()) {
			stopPlayback();
			return;
		}

		resizeEditor();
		const element = scrollElement;
		if (!element || !hasScript()) return;
		const maximumScroll = Math.max(
			0,
			element.scrollHeight - element.clientHeight,
		);
		if (maximumScroll <= 1) return;
		if (element.scrollTop >= maximumScroll - 1) element.scrollTop = 0;
		playbackPosition = element.scrollTop;
		setSettingsOpen(false);
		setIsPlaying(true);
		playbackTimestamp = undefined;
		playbackFrame = requestAnimationFrame(animatePlayback);
	}

	function changeFontSize(delta: number) {
		setState((current) => ({
			...current,
			fontSize: clamp(current.fontSize + delta, 22, 52),
		}));
		requestAnimationFrame(resizeEditor);
	}

	return (
		<div
			onKeyDown={(event) => {
				if (event.key === "Escape") setSettingsOpen(false);
			}}
			class={cx(
				"cap-window-shell relative flex h-screen w-screen flex-col overflow-hidden text-gray-12",
				!isMacOS &&
					"rounded-2xl border border-gray-5 bg-gray-1/90 shadow-2xl backdrop-blur-2xl",
			)}
			style={{
				opacity: isMacOS
					? "1"
					: `${clamp(state().windowOpacityPercent, 45, 100) / 100}`,
			}}
		>
			<header
				data-tauri-drag-region
				class="cap-window-header flex h-9 shrink-0 items-center"
			>
				<Show when={isLinux}>
					<CaptionControlsMacOS
						class="ml-3"
						showMinimize={false}
						showZoom={false}
					/>
				</Show>
				<div
					data-tauri-drag-region
					class={cx(
						"pointer-events-none ml-auto flex items-center gap-1.5 text-[10px] text-gray-9",
						isWindows ? "mr-1" : "mr-3",
					)}
				>
					<IconLucideEyeOff class="size-3" />
					<span>
						{isLinux
							? "This window may appear in recordings on Linux"
							: "This window is hidden from Cap recordings"}
					</span>
				</div>
				<Show when={isWindows}>
					<CaptionControlsWindows11 />
				</Show>
			</header>

			<main class="cap-window-body relative min-h-0 flex-1 overflow-hidden">
				<Show when={state().showCueMarkers}>
					<div class="pointer-events-none absolute inset-x-3 top-1/2 z-20 flex -translate-y-1/2 items-center justify-between text-blue-10/75 drop-shadow-sm">
						<IconLucideChevronRight class="size-4" />
						<IconLucideChevronLeft class="size-4" />
					</div>
				</Show>
				<div
					ref={scrollElement}
					onClick={() => editorElement?.focus()}
					class={cx(
						"relative z-10 h-full w-full overflow-y-auto overscroll-contain scrollbar-none",
						state().mirror && "scale-x-[-1]",
					)}
					style={{
						"mask-image":
							"linear-gradient(to bottom, rgba(0, 0, 0, 0.4) 0%, black 34%, black 66%, rgba(0, 0, 0, 0.4) 100%)",
						"-webkit-mask-image":
							"linear-gradient(to bottom, rgba(0, 0, 0, 0.4) 0%, black 34%, black 66%, rgba(0, 0, 0, 0.4) 100%)",
					}}
				>
					<div aria-hidden="true" style={{ height: spacerHeight() }} />
					<textarea
						ref={editorElement}
						autofocus
						rows={1}
						spellcheck={true}
						value={state().script}
						onInput={(event) => updateScript(event.currentTarget.value)}
						placeholder="Paste or type your script…"
						class="block w-full resize-none overflow-hidden bg-transparent px-8 text-center font-medium tracking-[-0.025em] text-gray-12 outline-none placeholder:text-gray-8/70 selection:bg-blue-9/25"
						style={{
							"font-size": `${state().fontSize}px`,
							"line-height": state().lineHeight,
						}}
						aria-label="Teleprompter script"
					/>
					<div aria-hidden="true" style={{ height: spacerHeight() }} />
				</div>
			</main>

			<Show when={settingsOpen()}>
				<div class="absolute bottom-12 right-2 z-30 w-48 rounded-2xl border border-gray-12/8 bg-gray-1/80 p-2 shadow-xl backdrop-blur-2xl">
					<div>
						<SettingToggle
							label="Cue markers"
							active={state().showCueMarkers}
							onChange={(showCueMarkers) =>
								setState((current) => ({ ...current, showCueMarkers }))
							}
						>
							<IconLucideChevronRight class="size-3.5" />
						</SettingToggle>
						<SettingToggle
							label="Mirror text"
							active={state().mirror}
							onChange={(mirror) =>
								setState((current) => ({ ...current, mirror }))
							}
						>
							<IconLucideFlipHorizontal2 class="size-3.5" />
						</SettingToggle>
					</div>
				</div>
			</Show>

			<footer class="flex h-11 shrink-0 items-center px-3 pb-2">
				<button
					type="button"
					title={isPlaying() ? "Pause" : "Play"}
					aria-label={isPlaying() ? "Pause" : "Play"}
					disabled={!hasScript()}
					onClick={togglePlayback}
					class="flex size-8 items-center justify-center rounded-full border border-gray-12/6 bg-gray-12/7 text-gray-12 shadow-sm backdrop-blur-xl transition hover:bg-gray-12/11 disabled:cursor-not-allowed disabled:opacity-30"
				>
					<Show
						when={isPlaying()}
						fallback={<IconLucidePlay class="size-3.5 fill-current" />}
					>
						<IconLucidePause class="size-3.5 fill-current" />
					</Show>
				</button>
				<div
					title={`Scroll speed: ${state().wordsPerMinute} wpm`}
					class="ml-1.5 flex h-8 items-center gap-1.5 rounded-full border border-gray-12/6 bg-gray-12/5 px-2 backdrop-blur-xl"
				>
					<IconLucideGauge class="size-3.5 shrink-0 text-gray-9" />
					<input
						type="range"
						min="60"
						max="350"
						step="5"
						value={state().wordsPerMinute}
						onInput={(event) =>
							setState((current) => ({
								...current,
								wordsPerMinute: Number(event.currentTarget.value),
							}))
						}
						class="h-1 w-12 cursor-pointer appearance-none rounded-full bg-gray-12/10 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-9 [&::-webkit-slider-thumb]:shadow-sm"
						aria-label="Scroll speed"
					/>
					<span class="w-12 text-right text-[10px] tabular-nums text-gray-9">
						{state().wordsPerMinute} wpm
					</span>
				</div>

				<div class="ml-auto flex items-center gap-1.5">
					<div
						title={`Window opacity: ${state().windowOpacityPercent}%`}
						class="flex h-8 items-center gap-1.5 rounded-full border border-gray-12/6 bg-gray-12/5 px-2 backdrop-blur-xl"
					>
						<IconLucideLayers class="size-3.5 shrink-0 text-gray-9" />
						<input
							type="range"
							min="45"
							max="100"
							step="5"
							value={state().windowOpacityPercent}
							onInput={(event) =>
								setState((current) => ({
									...current,
									windowOpacityPercent: Number(event.currentTarget.value),
								}))
							}
							class="h-1 w-12 cursor-pointer appearance-none rounded-full bg-gray-12/10 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gray-11 [&::-webkit-slider-thumb]:shadow-sm"
							aria-label="Window opacity"
						/>
					</div>
					<div class="flex h-8 items-center rounded-full border border-gray-12/6 bg-gray-12/5 px-0.5 backdrop-blur-xl">
						<ToolButton label="Smaller text" onClick={() => changeFontSize(-2)}>
							<IconLucideMinus class="size-3.5" />
						</ToolButton>
						<span class="w-6 text-center text-[10px] tabular-nums text-gray-9">
							{state().fontSize}
						</span>
						<ToolButton label="Larger text" onClick={() => changeFontSize(2)}>
							<IconLucidePlus class="size-3.5" />
						</ToolButton>
					</div>
					<ToolButton
						label="Settings"
						active={settingsOpen()}
						onClick={() => setSettingsOpen((open) => !open)}
					>
						<IconLucideSettings2 class="size-3.5" />
					</ToolButton>
				</div>
			</footer>
		</div>
	);
}
