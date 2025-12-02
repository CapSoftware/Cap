import { createElementBounds } from "@solid-primitives/bounds";
import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { type ComponentProps, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { TransitionGroup } from "solid-transition-group";
import { authStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCurrentRecordingQuery, createOptionsQuery } from "~/utils/queries";
import { handleRecordingResult } from "~/utils/recording";
import type { CameraInfo, CurrentRecording, DeviceOrModelID, RecordingInputKind } from "~/utils/tauri";
import { commands, events } from "~/utils/tauri";

type State =
	| { variant: "initializing" }
	| { variant: "countdown"; from: number; current: number }
	| { variant: "recording" }
	| { variant: "paused" }
	| { variant: "stopped" };

type RecordingInputState = Record<RecordingInputKind, boolean>;

declare global {
	interface Window {
		COUNTDOWN: number;
	}
}

const MAX_RECORDING_FOR_FREE = 5 * 60 * 1000;
const NO_MICROPHONE = "No Microphone";
const NO_WEBCAM = "No Webcam";
const FAKE_WINDOW_BOUNDS_NAME = "recording-controls-interactive-area";

export default function () {
	const [state, setState] = createSignal<State>(
		window.COUNTDOWN === 0
			? { variant: "initializing" }
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
	const startedWithMicrophone = optionsQuery.rawOptions.micName != null;
	const startedWithCameraInput = optionsQuery.rawOptions.cameraID != null;
	const auth = authStore.createQuery();

	const audioLevel = createAudioInputLevel();
	const [disconnectedInputs, setDisconnectedInputs] = createStore<RecordingInputState>({
		microphone: false,
		camera: false,
	});
	const [recordingFailure, setRecordingFailure] = createSignal<string | null>(null);
	const [issuePanelVisible, setIssuePanelVisible] = createSignal(false);
	const [issueKey, setIssueKey] = createSignal("");
	const [cameraWindowOpen, setCameraWindowOpen] = createSignal(false);
	const [interactiveAreaRef, setInteractiveAreaRef] = createSignal<HTMLDivElement | null>(null);
	const interactiveBounds = createElementBounds(interactiveAreaRef);
	let settingsButtonRef: HTMLButtonElement | undefined;
	const recordingMode = createMemo(() => currentRecording.data?.mode ?? optionsQuery.rawOptions.mode);
	const canPauseRecording = createMemo(() => {
		const mode = recordingMode();
		const os = ostype();
		return mode === "studio" || os === "macos" || (os === "windows" && mode === "instant");
	});

	const hasDisconnectedInput = () => disconnectedInputs.microphone || disconnectedInputs.camera;

	const issueMessages = createMemo(() => {
		const issues: string[] = [];
		if (disconnectedInputs.microphone) issues.push("Microphone disconnected. Reconnect it to continue recording.");
		if (disconnectedInputs.camera) issues.push("Camera disconnected. Reconnect it to continue recording.");
		const failure = recordingFailure();
		if (failure) issues.push(failure);
		return issues;
	});

	const hasRecordingIssue = () => issueMessages().length > 0;

	const toggleIssuePanel = () => {
		if (!hasRecordingIssue()) return;
		setIssuePanelVisible((visible) => !visible);
	};

	const dismissIssuePanel = () => setIssuePanelVisible(false);
	const hasCameraInput = () => optionsQuery.rawOptions.cameraID != null;
	const microphoneTitle = createMemo(() => {
		if (disconnectedInputs.microphone) return "Microphone disconnected";
		if (optionsQuery.rawOptions.micName) return `Microphone: ${optionsQuery.rawOptions.micName}`;
		return "Microphone not configured";
	});

	const [pauseResumes, setPauseResumes] = createStore<
		[] | [...Array<{ pause: number; resume?: number }>, { pause: number; resume?: number }]
	>([]);

	createEffect(() => {
		const messages = issueMessages();
		if (messages.length === 0) {
			setIssueKey("");
			setIssuePanelVisible(false);
			return;
		}
		const nextKey = messages.join("||");
		if (nextKey !== issueKey()) {
			setIssueKey(nextKey);
			setIssuePanelVisible(true);
		}
	});

	createTauriEventListener(events.recordingEvent, (payload) => {
		switch (payload.variant) {
			case "Countdown":
				setState((s) => {
					if (s.variant === "countdown") return { ...s, current: payload.value };

					return s;
				});
				break;
			case "Started":
				setDisconnectedInputs({ microphone: false, camera: false });
				setRecordingFailure(null);
				setState({ variant: "recording" });
				setStart(Date.now());
				break;
			case "InputLost": {
				const wasDisconnected = hasDisconnectedInput();
				setDisconnectedInputs(payload.input, () => true);
				if (!wasDisconnected && state().variant === "recording") {
					setPauseResumes((a) => [...a, { pause: Date.now() }]);
				}
				setState({ variant: "paused" });
				setTime(Date.now());
				break;
			}
			case "InputRestored":
				setDisconnectedInputs(payload.input, () => false);
				break;
			case "Failed":
				setRecordingFailure(payload.error);
				break;
		}
	});

	createEffect(() => {
		const s = state();
		if (s.variant === "initializing" || s.variant === "countdown") {
			const recording = currentRecording.data as CurrentRecording | undefined;
			if (recording?.status === "recording") {
				setDisconnectedInputs({ microphone: false, camera: false });
				setRecordingFailure(null);
				setState({ variant: "recording" });
				setStart(Date.now());
			}
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
	const refreshCameraWindowState = async () => {
		try {
			setCameraWindowOpen(await commands.isCameraWindowOpen());
		} catch {
			setCameraWindowOpen(false);
		}
	};

	createEffect(() => {
		void refreshCameraWindowState();
	});

	createEffect(() => {
		const element = interactiveAreaRef();
		if (!element) {
			void commands.removeFakeWindow(FAKE_WINDOW_BOUNDS_NAME);
			return;
		}

		const left = interactiveBounds.left ?? 0;
		const top = interactiveBounds.top ?? 0;
		const width = interactiveBounds.width ?? 0;
		const height = interactiveBounds.height ?? 0;

		if (width === 0 || height === 0) return;

		void commands.setFakeWindowBounds(FAKE_WINDOW_BOUNDS_NAME, {
			position: { x: left, y: top },
			size: { width, height },
		});
	});

	onCleanup(() => {
		void commands.removeFakeWindow(FAKE_WINDOW_BOUNDS_NAME);
	});

	createTimer(
		() => {
			void refreshCameraWindowState();
		},
		2000,
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

	const toggleCameraPreview = createMutation(() => ({
		mutationFn: async () => {
			if (cameraWindowOpen()) {
				const cameraWindow = await WebviewWindow.getByLabel("camera");
				if (cameraWindow) await cameraWindow.close();
			} else {
				await commands.showWindow("Camera");
			}
			await refreshCameraWindowState();
		},
	}));

	const pauseRecordingForDeviceChange = async () => {
		if (state().variant !== "recording") return false;
		await commands.pauseRecording();
		setPauseResumes((a) => [...a, { pause: Date.now() }]);
		setState({ variant: "paused" });
		setTime(Date.now());
		return true;
	};

	const updateMicInput = createMutation(() => ({
		mutationFn: async (name: string | null) => {
			if (!startedWithMicrophone && name !== null) return;
			const previous = optionsQuery.rawOptions.micName ?? null;
			if (previous === name) return;
			await pauseRecordingForDeviceChange();
			optionsQuery.setOptions("micName", name);
			try {
				await commands.setMicInput(name);
			} catch (error) {
				optionsQuery.setOptions("micName", previous);
				throw error;
			}
		},
	}));

	const updateCameraInput = createMutation(() => ({
		mutationFn: async (camera: CameraInfo | null) => {
			if (!startedWithCameraInput && camera != null) return;
			const selected = optionsQuery.rawOptions.cameraID ?? null;
			if (!camera && selected === null) return;
			if (camera && cameraMatchesSelection(camera, selected)) return;
			await pauseRecordingForDeviceChange();
			const next = cameraInfoToId(camera);
			const previous = cloneDeviceOrModelId(selected);
			optionsQuery.setOptions("cameraID", next);
			try {
				await commands.setCameraInput(next);
				if (!next && cameraWindowOpen()) {
					const cameraWindow = await WebviewWindow.getByLabel("camera");
					if (cameraWindow) await cameraWindow.close();
					await refreshCameraWindowState();
				}
			} catch (error) {
				optionsQuery.setOptions("cameraID", previous);
				throw error;
			}
		},
	}));

	const openRecordingSettingsMenu = async () => {
		try {
			let audioDevices: string[] = [];
			let videoDevices: CameraInfo[] = [];
			try {
				audioDevices = await commands.listAudioDevices();
			} catch {
				audioDevices = [];
			}
			try {
				videoDevices = await commands.listCameras();
			} catch {
				videoDevices = [];
			}
			const items: (
				| Awaited<ReturnType<typeof CheckMenuItem.new>>
				| Awaited<ReturnType<typeof MenuItem.new>>
				| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
			)[] = [];
			items.push(
				await CheckMenuItem.new({
					text: "Show Camera Preview",
					checked: cameraWindowOpen(),
					enabled: startedWithCameraInput && hasCameraInput(),
					action: () => {
						if (!startedWithCameraInput || !hasCameraInput()) return;
						toggleCameraPreview.mutate();
					},
				})
			);
			items.push(await PredefinedMenuItem.new({ item: "Separator" }));
			items.push(
				await MenuItem.new({
					text: startedWithMicrophone ? "Microphone" : "Microphone (locked for this recording)",
					enabled: false,
				})
			);
			items.push(
				await CheckMenuItem.new({
					text: NO_MICROPHONE,
					checked: optionsQuery.rawOptions.micName == null,
					enabled: startedWithMicrophone,
					action: () => updateMicInput.mutate(null),
				})
			);
			for (const name of audioDevices) {
				items.push(
					await CheckMenuItem.new({
						text: name,
						checked: optionsQuery.rawOptions.micName === name,
						enabled: startedWithMicrophone,
						action: () => updateMicInput.mutate(name),
					})
				);
			}
			items.push(await PredefinedMenuItem.new({ item: "Separator" }));
			items.push(
				await MenuItem.new({
					text: startedWithCameraInput ? "Webcam" : "Webcam (locked for this recording)",
					enabled: false,
				})
			);
			items.push(
				await CheckMenuItem.new({
					text: NO_WEBCAM,
					checked: !hasCameraInput(),
					enabled: startedWithCameraInput,
					action: () => updateCameraInput.mutate(null),
				})
			);
			for (const camera of videoDevices) {
				items.push(
					await CheckMenuItem.new({
						text: camera.display_name,
						checked: cameraMatchesSelection(camera, optionsQuery.rawOptions.cameraID ?? null),
						enabled: startedWithCameraInput,
						action: () => updateCameraInput.mutate(camera),
					})
				);
			}
			const menu = await Menu.new({ items });
			const rect = settingsButtonRef?.getBoundingClientRect();
			if (rect) menu.popup(new LogicalPosition(rect.x, rect.y + rect.height + 4));
			else menu.popup();
		} catch (error) {
			console.error("Failed to open recording settings menu", error);
		}
	};

	const adjustedTime = () => {
		if (state().variant === "countdown" || state().variant === "initializing") return 0;
		let t = time() - start();
		for (const { pause, resume } of pauseResumes) {
			if (pause && resume) t -= resume - pause;
		}
		return Math.max(0, t);
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

	const isInitializing = () => state().variant === "initializing";
	const isCountdown = () => state().variant === "countdown";
	const countdownCurrent = () => {
		const s = state();
		return s.variant === "countdown" ? s.current : 0;
	};

	return (
		<div class="flex h-full w-full flex-col justify-end px-3 pb-3">
			<div ref={setInteractiveAreaRef} class="flex w-full flex-col gap-2">
				<Show when={hasRecordingIssue() && issuePanelVisible()}>
					<div class="flex w-full flex-row items-start gap-3 rounded-2xl border border-red-8 bg-gray-1 px-4 py-3 text-[12px] leading-snug text-red-11 shadow-lg">
						<IconLucideAlertTriangle class="mt-0.5 size-5 text-red-9" />
						<div class="flex-1 space-y-1">
							{issueMessages().map((message) => (
								<p>{message}</p>
							))}
						</div>
						<button
							type="button"
							class="text-red-9 transition hover:text-red-11"
							onClick={() => dismissIssuePanel()}
							aria-label="Dismiss recording issue"
						>
							<IconLucideX class="size-4" />
						</button>
					</div>
				</Show>
				<div class="h-10 w-full rounded-2xl">
					<div class="flex h-full w-full flex-row items-stretch overflow-hidden rounded-2xl bg-gray-1 border border-gray-5 shadow-[0_1px_3px_rgba(0,0,0,0.1)] animate-in fade-in">
						<div class="flex flex-1 flex-col gap-2 p-[0.25rem]">
							<div class="flex flex-1 flex-row justify-between">
								<button
									disabled={stopRecording.isPending || isInitializing() || isCountdown()}
									class="flex flex-row items-center gap-[0.25rem] rounded-lg py-[0.25rem] px-[0.5rem] text-red-300 transition-opacity disabled:opacity-60"
									type="button"
									onClick={() => stopRecording.mutate()}
									title="Stop recording"
									aria-label="Stop recording"
								>
									<IconCapStopCircle />
									<span class="text-[0.875rem] font-[500] tabular-nums">
										<Show when={!isInitializing()} fallback="Starting">
											<Show
												when={!isCountdown()}
												fallback={
													<div class="relative inline-block h-[1.5em] w-[1ch] overflow-hidden align-middle">
														<TransitionGroup
															onEnter={(el, done) => {
																const a = el.animate(
																	[
																		{
																			opacity: 0,
																			transform: "translateY(-100%)",
																		},
																		{ opacity: 1, transform: "translateY(0)" },
																	],
																	{
																		duration: 300,
																		easing: "cubic-bezier(0.16, 1, 0.3, 1)",
																	}
																);
																a.finished.then(done);
															}}
															onExit={(el, done) => {
																const a = el.animate(
																	[
																		{ opacity: 1, transform: "translateY(0)" },
																		{
																			opacity: 0,
																			transform: "translateY(100%)",
																		},
																	],
																	{
																		duration: 300,
																		easing: "cubic-bezier(0.16, 1, 0.3, 1)",
																	}
																);
																a.finished.then(done);
															}}
														>
															<For each={[countdownCurrent()]}>
																{(num) => <span class="absolute inset-0 flex items-center justify-center">{num}</span>}
															</For>
														</TransitionGroup>
													</div>
												}
											>
												<Show when={isMaxRecordingLimitEnabled()} fallback={formatTime(adjustedTime() / 1000)}>
													{formatTime(remainingRecordingTime() / 1000)}
												</Show>
											</Show>
										</Show>
									</span>
								</button>

								<div class="flex items-center gap-1">
									<div class="relative flex h-8 w-8 items-center justify-center" title={microphoneTitle()}>
										{optionsQuery.rawOptions.micName != null ? (
											disconnectedInputs.microphone ? (
												<IconLucideMicOff class="size-5 text-amber-11" />
											) : (
												<>
													<IconCapMicrophone class="size-5 text-gray-12" />
													<div class="absolute bottom-1 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-gray-10">
														<div
															class="absolute inset-0 bg-blue-9 transition-transform duration-100"
															style={{
																transform: `translateX(-${(1 - audioLevel()) * 100}%)`,
															}}
														/>
													</div>
												</>
											)
										) : (
											<IconLucideMicOff class="size-5 text-gray-7" data-tauri-drag-region />
										)}
									</div>
									<Show when={hasRecordingIssue()}>
										<ActionButton
											class={cx(
												"text-red-10 hover:bg-red-3/40",
												issuePanelVisible() && "bg-red-3/40 ring-1 ring-red-8"
											)}
											onClick={() => toggleIssuePanel()}
											title={issueMessages().join(", ")}
											aria-pressed={issuePanelVisible() ? "true" : "false"}
											aria-label="Recording issues"
										>
											<IconLucideAlertTriangle class="size-5" />
										</ActionButton>
									</Show>

									{canPauseRecording() && (
										<ActionButton
											disabled={togglePause.isPending || hasDisconnectedInput() || isCountdown()}
											onClick={() => togglePause.mutate()}
											title={state().variant === "paused" ? "Resume recording" : "Pause recording"}
											aria-label={state().variant === "paused" ? "Resume recording" : "Pause recording"}
										>
											{state().variant === "paused" ? <IconCapPlayCircle /> : <IconCapPauseCircle />}
										</ActionButton>
									)}

									<ActionButton
										disabled={restartRecording.isPending || isCountdown()}
										onClick={() => restartRecording.mutate()}
										title="Restart recording"
										aria-label="Restart recording"
									>
										<IconCapRestart />
									</ActionButton>
									<ActionButton
										disabled={deleteRecording.isPending || isCountdown()}
										onClick={() => deleteRecording.mutate()}
										title="Delete recording"
										aria-label="Delete recording"
									>
										<IconCapTrash />
									</ActionButton>
									<ActionButton
										ref={(el) => {
											settingsButtonRef = el ?? undefined;
										}}
										onClick={() => {
											void openRecordingSettingsMenu();
										}}
										title="Recording settings"
										aria-label="Recording settings"
									>
										<IconCapSettings class="size-5" />
									</ActionButton>
								</div>
							</div>
						</div>
						<div
							class="non-styled-move flex cursor-move items-center justify-center border-l border-gray-5 p-[0.25rem] hover:cursor-move"
							data-tauri-drag-region
						>
							<IconCapMoreVertical class="pointer-events-none text-gray-10" />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function ActionButton(props: ComponentProps<"button">) {
	return (
		<button
			{...props}
			class={cx(
				"p-[0.25rem] rounded-lg transition-all",
				"text-gray-11",
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

function cameraMatchesSelection(camera: CameraInfo, selected?: DeviceOrModelID | null) {
	if (!selected) return false;
	if ("DeviceID" in selected) return selected.DeviceID === camera.device_id;
	return camera.model_id != null && selected.ModelID === camera.model_id;
}

function cameraInfoToId(camera: CameraInfo | null): DeviceOrModelID | null {
	if (!camera) return null;
	if (camera.model_id) return { ModelID: camera.model_id };
	return { DeviceID: camera.device_id };
}

function cloneDeviceOrModelId(id: DeviceOrModelID | null): DeviceOrModelID | null {
	if (!id) return null;
	if ("DeviceID" in id) return { DeviceID: id.DeviceID };
	return { ModelID: id.ModelID };
}
