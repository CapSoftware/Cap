import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { type ComponentProps, createEffect, createMemo, createSignal, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import createPresence from "solid-presence";
import { GrabHandleIcon, PauseIcon, PlayIcon, RestartIcon, StopIcon, TrashIcon } from "~/icons";
import { authStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCurrentRecordingQuery, createOptionsQuery } from "~/utils/queries";
import { handleRecordingResult } from "~/utils/recording";
import { commands, events } from "~/utils/tauri";

type State =
	| { variant: "countdown"; from: number; current: number }
	| { variant: "recording" }
	| { variant: "paused" }
	| { variant: "stopped" };

declare global {
	interface Window {
		COUNTDOWN: number;
	}
}

const MAX_RECORDING_FOR_FREE = 5 * 60 * 1000;

export default function () {
	const [state, setState] = createSignal<State>(
		window.COUNTDOWN === 0
			? { variant: "recording" }
			: {
					variant: "countdown",
					from: window.COUNTDOWN,
					current: window.COUNTDOWN,
			  }
	);
	const [start, setStart] = createSignal(Date.now());
	const [time, setTime] = createSignal(Date.now());
	const currentRecording = createCurrentRecordingQuery();
	const optionsQuery = createOptionsQuery();
	const auth = authStore.createQuery();

	const audioLevel = createAudioInputLevel();

	const [pauseResumes, setPauseResumes] = createStore<
		[] | [...Array<{ pause: number; resume?: number }>, { pause: number; resume?: number }]
	>([]);

	createTauriEventListener(events.recordingEvent, (payload) => {
		if (payload.variant === "Countdown") {
			setState((s) => {
				if (s.variant === "countdown") return { ...s, current: payload.value };

				return s;
			});
		} else if (payload.variant === "Started") {
			setState({ variant: "recording" });
			setStart(Date.now());
		}
	});

	createTimer(
		() => {
			if (state().variant !== "recording") return;
			setTime(Date.now());
		},
		100,
		setInterval
	);

	createEffect(() => {
		if (
			state().variant === "stopped" &&
			!currentRecording.isPending &&
			(currentRecording.data === undefined || currentRecording.data === null)
		)
			getCurrentWindow().close();
	});

	const stopRecording = createMutation(() => ({
		mutationFn: async () => {
			setState({ variant: "stopped" });
			await commands.stopRecording();
		},
	}));

	const togglePause = createMutation(() => ({
		mutationFn: async () => {
			if (state().variant === "paused") {
				await commands.resumeRecording();
				setPauseResumes(
					produce((a) => {
						if (a.length === 0) return a;
						a[a.length - 1].resume = Date.now();
					})
				);
				setState({ variant: "recording" });
			} else {
				await commands.pauseRecording();
				setPauseResumes((a) => [...a, { pause: Date.now() }]);
				setState({ variant: "paused" });
			}
			setTime(Date.now());
		},
	}));

	const restartRecording = createMutation(() => ({
		mutationFn: async () => {
			const shouldRestart = await dialog.confirm(
				"Are you sure you want to restart the recording? The current recording will be discarded.",
				{ title: "Confirm Restart", okLabel: "Restart", cancelLabel: "Cancel" }
			);

			if (!shouldRestart) return;

			await handleRecordingResult(commands.restartRecording(), undefined);

			setState({ variant: "recording" });
			setTime(Date.now());
		},
	}));

	const deleteRecording = createMutation(() => ({
		mutationFn: async () => {
			const shouldDelete = await dialog.confirm("Are you sure you want to delete the recording?", {
				title: "Confirm Delete",
				okLabel: "Delete",
				cancelLabel: "Cancel",
			});

			if (!shouldDelete) return;

			await commands.deleteRecording();

			setState({ variant: "stopped" });
		},
	}));

	const adjustedTime = () => {
		if (state().variant === "countdown") return 0;
		let t = time() - start();
		for (const { pause, resume } of pauseResumes) {
			if (pause && resume) t -= resume - pause;
		}
		return t;
	};

	const isMaxRecordingLimitEnabled = () => {
		// Only enforce the limit on instant mode.
		// We enforce it on studio mode when exporting.
		return (
			optionsQuery.rawOptions.mode === "instant" &&
			// If the data is loaded and the user is not upgraded
			auth.data?.plan?.upgraded === false
		);
	};

	let aborted = false;
	createEffect(() => {
		if (isMaxRecordingLimitEnabled() && adjustedTime() > MAX_RECORDING_FOR_FREE && !aborted) {
			aborted = true;
			stopRecording.mutate();
		}
	});

	const remainingRecordingTime = () => {
		if (MAX_RECORDING_FOR_FREE < adjustedTime()) return 0;
		return MAX_RECORDING_FOR_FREE - adjustedTime();
	};

	const [countdownRef, setCountdownRef] = createSignal<HTMLDivElement | null>(null);
	const showCountdown = () => state().variant === "countdown";
	const countdownPresence = createPresence({
		show: showCountdown,
		element: countdownRef,
	});
	const countdownState = createMemo<Extract<State, { variant: "countdown" }> | undefined>((prev) => {
		const s = state();
		if (s.variant === "countdown") return s;
		if (prev && countdownPresence.present()) return prev;
	});

	return (
		<div
			class="flex flex-row items-stretch w-full h-full animate-in fade-in rounded-[18px] border border-white/15"
			style={{
				background:
					"linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.00) 50.48%), var(--neutral-950, #090A0B)",
				"background-blend-mode": "plus-lighter, normal",
				"box-shadow":
					"0 1px 1px -0.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 3px 3px -1.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 6px 6px -3px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 12px 12px -6px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16))",
			}}
		>
			{/* <Show when={countdownState()}>
				{(state) => (
					<div ref={setCountdownRef} class={cx("transition-opacity", showCountdown() ? "opacity-100" : "opacity-0")}>
						<Countdown from={state().from} current={state().current} />
					</div>
				)}
			</Show> */}
			<div class="flex flex-row items-center px-2 flex-1 gap-0">
				<button
					disabled={stopRecording.isPending}
					class="px-2 h-8 text-red-300 gap-1 flex flex-row items-center justify-center rounded-lg transition-opacity disabled:opacity-60 hover:bg-white/5"
					type="button"
					onClick={() => stopRecording.mutate()}
				>
					<StopIcon class="size-4" />
					<span class="font-[500] text-[0.875rem] tabular-nums text-white px-1">
						<Show when={isMaxRecordingLimitEnabled()} fallback={formatTime(adjustedTime() / 1000)}>
							{formatTime(remainingRecordingTime() / 1000)}
						</Show>
					</span>
				</button>

				<div class="flex gap-0 items-center">
					{/* <div class="flex relative justify-center items-center w-8 h-8">
						{optionsQuery.rawOptions.micName != null ? (
							<>
								<IconCapMicrophone class="size-5 text-gray-12" />
								<div class="absolute bottom-1 left-1 right-1 h-0.5 bg-gray-10 overflow-hidden rounded-full">
									<div
										class="absolute inset-0 transition-transform duration-100 bg-blue-9"
										style={{
											transform: `translateX(-${(1 - audioLevel()) * 100}%)`,
										}}
									/>
								</div>
							</>
						) : (
							<IconLucideMicOff class="text-gray-7 size-5" data-tauri-drag-region />
						)}
					</div> */}

					{(currentRecording.data?.mode === "studio" || ostype() === "macos") && (
						<ActionButton disabled={togglePause.isPending} onClick={() => togglePause.mutate()}>
							{state().variant === "paused" ? <PlayIcon /> : <PauseIcon />}
						</ActionButton>
					)}

					<ActionButton disabled={restartRecording.isPending} onClick={() => restartRecording.mutate()}>
						<RestartIcon />
					</ActionButton>
					<ActionButton disabled={deleteRecording.isPending} onClick={() => deleteRecording.mutate()}>
						<TrashIcon />
					</ActionButton>

					<div
						class="non-styled-move cursor-move flex items-center justify-center h-8 pl-0.5 hover:cursor-move"
						data-tauri-drag-region
					>
						<GrabHandleIcon class="pointer-events-none text-white/80 hover:text-white" />
					</div>
				</div>
			</div>
			{/* <div
				class="non-styled-move cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-5 hover:cursor-move"
				data-tauri-drag-region
			>
				<IconCapMoreVertical class="pointer-events-none text-gray-10" />
			</div> */}
		</div>
	);
}

function ActionButton(props: ComponentProps<"button">) {
	return (
		<button
			{...props}
			class={cx(
				"p-[0.25rem] rounded-lg transition-all",
				"text-white hover:bg-white/5",
				"h-8 w-8 flex items-center justify-center",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				props.class
			)}
			type="button"
		/>
	);
}

function formatTime(secs: number) {
	const minutes = Math.floor(secs / 60);
	const seconds = Math.floor(secs % 60);

	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function createAudioInputLevel() {
	const [level, setLevel] = createSignal(0);

	createTauriEventListener(events.audioInputLevelChange, (dbs) => {
		const DB_MIN = -60;
		const DB_MAX = 0;

		const dbValue = dbs ?? DB_MIN;
		const normalizedLevel = Math.max(0, Math.min(1, (dbValue - DB_MIN) / (DB_MAX - DB_MIN)));
		setLevel(normalizedLevel);
	});

	return level;
}

function Countdown(props: { from: number; current: number }) {
	const [animation, setAnimation] = createSignal(1);
	setTimeout(() => setAnimation(0), 10);

	return (
		<div
			class="flex flex-row justify-between p-[0.25rem] flex-1 fixed inset-0 z-10 rounded-[18px] border border-white/15"
			style={{
				background:
					"linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.00) 50.48%), var(--neutral-950, #090A0B)",
				"background-blend-mode": "plus-lighter, normal",
				"box-shadow":
					"0 1px 1px -0.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 3px 3px -1.5px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 6px 6px -3px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16)), 0 12px 12px -6px var(--_shadow-surface-layer, rgba(0, 0, 0, 0.16))",
			}}
		>
			<div class="flex flex-1 gap-3 items-center px-3">
				<div class="flex-1 text-[13px] text-gray-11">Recording starting...</div>
				<div class="relative w-5 h-5 text-red-300">
					<svg class="absolute inset-0 w-5 h-5 -rotate-90" viewBox="0 0 20 20">
						<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2" />
						<circle
							cx="10"
							cy="10"
							r="8"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-dasharray={`${animation() * 50.265} 50.265`}
							stroke-linecap="round"
							class="transition-all duration-1000 ease-linear"
							style={{
								"transition-duration": `${props.from * 1000}ms`,
							}}
						/>
					</svg>
					<span class="flex absolute inset-0 justify-center items-center text-[11px]">{props.current}</span>
				</div>
			</div>
		</div>
	);
}
