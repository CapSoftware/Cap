import { createElementBounds } from "@solid-primitives/bounds";
import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import createPresence from "solid-presence";
import {
  GrabHandleIcon,
  PauseIcon,
  PlayIcon,
  RestartIcon,
  StopIcon,
  TrashIcon,
} from "~/icons";
import { authStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import {
  createCurrentRecordingQuery,
  createOptionsQuery,
} from "~/utils/queries";
import { handleRecordingResult } from "~/utils/recording";
import type {
  CameraInfo,
  DeviceOrModelID,
  RecordingInputKind,
} from "~/utils/tauri";
import { commands, events } from "~/utils/tauri";

type State =
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
  const startedWithMicrophone = optionsQuery.rawOptions.micName != null;
  const startedWithCameraInput = optionsQuery.rawOptions.cameraID != null;
  const auth = authStore.createQuery();

  const audioLevel = createAudioInputLevel();
  const [disconnectedInputs, setDisconnectedInputs] =
    createStore<RecordingInputState>({
      microphone: false,
      camera: false,
    });
  const [recordingFailure, setRecordingFailure] = createSignal<string | null>(
    null
  );
  const [issuePanelVisible, setIssuePanelVisible] = createSignal(false);
  const [issueKey, setIssueKey] = createSignal("");
  const [cameraWindowOpen, setCameraWindowOpen] = createSignal(false);
  const [interactiveAreaRef, setInteractiveAreaRef] =
    createSignal<HTMLDivElement | null>(null);
  const interactiveBounds = createElementBounds(interactiveAreaRef);
  let settingsButtonRef: HTMLButtonElement | undefined;
  const recordingMode = createMemo(
    () => currentRecording.data?.mode ?? optionsQuery.rawOptions.mode
  );
  const canPauseRecording = createMemo(() => {
    const mode = recordingMode();
    const os = ostype();
    return (
      mode === "studio" ||
      os === "macos" ||
      (os === "windows" && mode === "instant")
    );
  });

  const hasDisconnectedInput = () =>
    disconnectedInputs.microphone || disconnectedInputs.camera;

  const issueMessages = createMemo(() => {
    const issues: string[] = [];
    if (disconnectedInputs.microphone)
      issues.push(
        "Microphone disconnected. Reconnect it to continue recording."
      );
    if (disconnectedInputs.camera)
      issues.push("Camera disconnected. Reconnect it to continue recording.");
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
    if (optionsQuery.rawOptions.micName)
      return `Microphone: ${optionsQuery.rawOptions.micName}`;
    return "Microphone not configured";
  });

  const [pauseResumes, setPauseResumes] = createStore<
    | []
    | [
        ...Array<{ pause: number; resume?: number }>,
        { pause: number; resume?: number }
      ]
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
          if (s.variant === "countdown")
            return { ...s, current: payload.value };

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
      const shouldDelete = await dialog.confirm(
        "Are you sure you want to delete the recording?",
        {
          title: "Confirm Delete",
          okLabel: "Delete",
          cancelLabel: "Cancel",
        }
      );

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
          text: startedWithMicrophone
            ? "Microphone"
            : "Microphone (locked for this recording)",
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
          text: startedWithCameraInput
            ? "Webcam"
            : "Webcam (locked for this recording)",
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
            checked: cameraMatchesSelection(
              camera,
              optionsQuery.rawOptions.cameraID ?? null
            ),
            enabled: startedWithCameraInput,
            action: () => updateCameraInput.mutate(camera),
          })
        );
      }
      const menu = await Menu.new({ items });
      const rect = settingsButtonRef?.getBoundingClientRect();
      if (rect)
        menu.popup(new LogicalPosition(rect.x, rect.y + rect.height + 4));
      else menu.popup();
    } catch (error) {
      console.error("Failed to open recording settings menu", error);
    }
  };

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
    if (
      isMaxRecordingLimitEnabled() &&
      adjustedTime() > MAX_RECORDING_FOR_FREE &&
      !aborted
    ) {
      aborted = true;
      stopRecording.mutate();
    }
  });

  const remainingRecordingTime = () => {
    if (MAX_RECORDING_FOR_FREE < adjustedTime()) return 0;
    return MAX_RECORDING_FOR_FREE - adjustedTime();
  };

  const [countdownRef, setCountdownRef] = createSignal<HTMLDivElement | null>(
    null
  );
  const showCountdown = () => state().variant === "countdown";
  const countdownPresence = createPresence({
    show: showCountdown,
    element: countdownRef,
  });
  const countdownState = createMemo<
    Extract<State, { variant: "countdown" }> | undefined
  >((prev) => {
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
      <Show when={countdownState()}>
        {(state) => (
          <div
            ref={setCountdownRef}
            class={cx(
              "transition-opacity",
              showCountdown() ? "opacity-100" : "opacity-0"
            )}
          >
            <Countdown from={state().from} current={state().current} />
          </div>
        )}
      </Show>
      <div class="flex flex-row items-center px-2 flex-1 gap-0">
        <button
          disabled={stopRecording.isPending}
          class="px-2 h-8 text-red-300 gap-1 flex flex-row items-center justify-center rounded-lg transition-opacity disabled:opacity-60 hover:bg-white/5"
          type="button"
          onClick={() => stopRecording.mutate()}
        >
          <StopIcon class="size-4" />
          <span class="font-[500] text-[0.875rem] tabular-nums text-white px-1">
            <Show
              when={isMaxRecordingLimitEnabled()}
              fallback={formatTime(adjustedTime() / 1000)}
            >
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

          {(currentRecording.data?.mode === "studio" ||
            ostype() === "macos") && (
            <ActionButton
              disabled={togglePause.isPending}
              onClick={() => togglePause.mutate()}
            >
              {state().variant === "paused" ? <PlayIcon /> : <PauseIcon />}
            </ActionButton>
          )}

          <ActionButton
            disabled={restartRecording.isPending}
            onClick={() => restartRecording.mutate()}
          >
            <RestartIcon />
          </ActionButton>
          <ActionButton
            disabled={deleteRecording.isPending}
            onClick={() => deleteRecording.mutate()}
          >
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
    const normalizedLevel = Math.max(
      0,
      Math.min(1, (dbValue - DB_MIN) / (DB_MAX - DB_MIN))
    );
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
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              opacity="0.2"
            />
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
          <span class="flex absolute inset-0 justify-center items-center text-[11px]">
            {props.current}
          </span>
        </div>
      </div>
    </div>
  );
}

function cameraMatchesSelection(
  camera: CameraInfo,
  selected?: DeviceOrModelID | null
) {
  if (!selected) return false;
  if ("DeviceID" in selected) return selected.DeviceID === camera.device_id;
  return camera.model_id != null && selected.ModelID === camera.model_id;
}

function cameraInfoToId(camera: CameraInfo | null): DeviceOrModelID | null {
  if (!camera) return null;
  if (camera.model_id) return { ModelID: camera.model_id };
  return { DeviceID: camera.device_id };
}

function cloneDeviceOrModelId(
  id: DeviceOrModelID | null
): DeviceOrModelID | null {
  if (!id) return null;
  if ("DeviceID" in id) return { DeviceID: id.DeviceID };
  return { ModelID: id.ModelID };
}
