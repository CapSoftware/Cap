import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
  createEffect,
  createSignal,
  type ComponentProps,
  Show,
  onMount,
  onCleanup,
} from "solid-js";
import { createStore, produce } from "solid-js/store";

import IconCapStopCircle from "~icons/cap/stop-circle";
import IconCapMicrophone from "~icons/cap/microphone";
import IconLucideMicOff from "~icons/lucide/mic-off";
import IconCapPlayCircle from "~icons/cap/play-circle";
import IconCapPauseCircle from "~icons/cap/pause-circle";
import IconCapRestart from "~icons/cap/restart";
import IconCapTrash from "~icons/cap/trash";
import IconCapMoreVertical from "~icons/cap/more-vertical";

import {
  createCurrentRecordingQuery,
  createOptionsQuery,
} from "~/utils/queries";
import { commands, events } from "~/utils/tauri";
import { generalSettingsStore } from "~/store";

type State = "countdown" | "recording" | "paused" | "stopped";

async function handleRecordingError(err: unknown) {
  const errorMessage =
    typeof err === "string"
      ? err
      : err instanceof Error
      ? err.message
      : "Unknown error";

  if (errorMessage.includes("Video upload info not found")) {
    await dialog.message(
      "Unable to start instant recording. Please ensure you are connected to the internet and the Cap service is available.",
      {
        title: "Recording Failed",
        kind: "error",
      }
    );
  } else if (errorMessage.includes("Please sign in to use instant recording")) {
    await dialog.message("Please sign in to use instant recording mode.", {
      title: "Sign In Required",
      kind: "error",
    });
  } else {
    await dialog.message(`Failed to start recording: ${errorMessage}`, {
      title: "Recording Failed",
      kind: "error",
    });
  }

  getCurrentWindow().close();
}

export default function () {
  const [countdown, setCountdown] = createSignal<number>(0);
  const [countdownDuration, setCountdownDuration] = createSignal<number>(3);
  const [start, setStart] = createSignal(Date.now());
  const [time, setTime] = createSignal(Date.now());
  const [state, setState] = createSignal<State>("recording");
  const currentRecording = createCurrentRecordingQuery();
  const optionsQuery = createOptionsQuery();
  let countdownInterval: ReturnType<typeof setInterval> | undefined;
  let hasStartedCountdown = false;

  const audioLevel = createAudioInputLevel();

  const [pauseResumes, setPauseResumes] = createStore<
    | []
    | [
        ...Array<{ pause: number; resume?: number }>,
        { pause: number; resume?: number }
      ]
  >([]);

  onMount(async () => {
    const settings = await generalSettingsStore.get();
    const countdownSetting = settings?.recordingCountdown ?? "three";

    const unlistenRecordingStarted = await events.recordingStarted.listen(
      () => {
        setState("recording");
        setStart(Date.now());
      }
    );

    // Wait for options to be loaded
    createEffect(() => {
      const { rawOptions } = optionsQuery;
      if (!rawOptions) {
        console.log("Recording options not yet available");
        return;
      }

      // Only run this effect once when rawOptions becomes available
      if (hasStartedCountdown) return;
      hasStartedCountdown = true;

      console.log("Starting recording with options:", rawOptions);

      if (countdownSetting !== "off") {
        setState("countdown");
        const countdownSeconds = countdownSetting === "five" ? 5 : 3;
        setCountdown(countdownSeconds);
        setCountdownDuration(countdownSeconds);

        countdownInterval = setInterval(() => {
          setCountdown((c) => {
            if (c <= 1) {
              clearInterval(countdownInterval!);
              countdownInterval = undefined;
              commands
                .startRecording({
                  capture_target: rawOptions.captureTarget,
                  mode: rawOptions.mode,
                  capture_system_audio: rawOptions.captureSystemAudio,
                })
                .catch((err) => {
                  console.error("Failed to start recording:", err);
                  handleRecordingError(err);
                });
              return 0;
            }
            return c - 1;
          });
        }, 1000);
      } else {
        commands
          .startRecording({
            capture_target: rawOptions.captureTarget,
            mode: rawOptions.mode,
            capture_system_audio: rawOptions.captureSystemAudio,
          })
          .catch((err) => {
            console.error("Failed to start recording:", err);
            handleRecordingError(err);
          });
      }
    });

    onCleanup(() => {
      unlistenRecordingStarted();
      if (countdownInterval) {
        clearInterval(countdownInterval);
      }
    });
  });

  createTimer(
    () => {
      if (state() !== "recording") return;
      setTime(Date.now());
    },
    100,
    setInterval
  );

  createEffect(() => {
    if (
      state() === "stopped" &&
      !currentRecording.isPending &&
      (currentRecording.data === undefined || currentRecording.data === null)
    )
      getCurrentWindow().close();
  });

  const stopRecording = createMutation(() => ({
    mutationFn: async () => {
      setState("stopped");
      await commands.stopRecording();
    },
  }));

  const togglePause = createMutation(() => ({
    mutationFn: async () => {
      if (state() === "paused") {
        await commands.resumeRecording();
        setPauseResumes(
          produce((a) => {
            if (a.length === 0) return a;
            a[a.length - 1].resume = Date.now();
          })
        );
        setState("recording");
      } else {
        await commands.pauseRecording();
        setPauseResumes((a) => [...a, { pause: Date.now() }]);
        setState("paused");
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

      await commands.restartRecording();

      setState("recording");
      setTime(Date.now());
    },
  }));

  const deleteRecording = createMutation(() => ({
    mutationFn: async () => {
      const shouldDelete = await dialog.confirm(
        "Are you sure you want to delete the recording?",
        { title: "Confirm Delete", okLabel: "Delete", cancelLabel: "Cancel" }
      );

      if (!shouldDelete) return;

      await commands.deleteRecording();

      setState("stopped");
    },
  }));

  const adjustedTime = () => {
    if (state() === "countdown") return 0;
    let t = time() - start();
    for (const { pause, resume } of pauseResumes) {
      if (pause && resume) t -= resume - pause;
    }
    return t;
  };

  return (
    <div class="flex flex-row items-stretch w-full h-full bg-gray-1 animate-in fade-in">
      <div class="flex flex-row justify-between p-[0.25rem] flex-1">
        <Show when={state() === "countdown"}>
          <div class="flex items-center gap-3 px-3 flex-1">
            <div class="text-gray-11 text-xs flex-1">
              Recording starting soon.
            </div>

            <button
              onClick={() => {
                if (countdownInterval) {
                  clearInterval(countdownInterval);
                  countdownInterval = undefined;
                }
                setCountdown(0);
                const { rawOptions } = optionsQuery;
                if (rawOptions) {
                  commands
                    .startRecording({
                      capture_target: rawOptions.captureTarget,
                      mode: rawOptions.mode,
                      capture_system_audio: rawOptions.captureSystemAudio,
                    })
                    .catch((err) => {
                      console.error("Failed to start recording:", err);
                      handleRecordingError(err);
                    });
                } else {
                  console.error("Recording options not available");
                }
              }}
              class="text-red-300 text-sm font-medium hover:text-red-400 hover:bg-gray-3 px-3 py-2 rounded-md transition-all flex items-center gap-2"
              type="button"
            >
              Continue
              <div class="relative w-5 h-5">
                <svg
                  class="absolute inset-0 w-5 h-5 -rotate-90"
                  viewBox="0 0 20 20"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="8"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    opacity="0.2"
                  />
                  <circle
                    cx="10"
                    cy="10"
                    r="8"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-dasharray={`${
                      (countdown() / countdownDuration()) * 50.265
                    } 50.265`}
                    stroke-linecap="round"
                    class="transition-all duration-1000 ease-linear"
                  />
                </svg>
                <span class="absolute inset-0 flex items-center justify-center text-xs">
                  {countdown()}
                </span>
              </div>
            </button>
          </div>
        </Show>
        <Show when={state() !== "countdown"}>
          <button
            disabled={stopRecording.isPending}
            class="py-[0.25rem] px-[0.5rem] text-red-300 gap-[0.25rem] flex flex-row items-center rounded-lg transition-opacity disabled:opacity-60"
            type="button"
            onClick={() => stopRecording.mutate()}
          >
            <IconCapStopCircle />
            <span class="font-[500] text-[0.875rem] tabular-nums">
              {formatTime(adjustedTime() / 1000)}
            </span>
          </button>
        </Show>

        <div class="flex gap-1 items-center">
          <Show when={state() !== "countdown"}>
            <div class="flex relative justify-center items-center w-8 h-8">
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
                <IconLucideMicOff
                  class="text-gray-7 size-5"
                  data-tauri-drag-region
                />
              )}
            </div>
          </Show>

          <Show when={state() !== "countdown"}>
            {(currentRecording.data?.type === "studio" ||
              ostype() === "macos") && (
              <ActionButton
                disabled={togglePause.isPending}
                onClick={() => togglePause.mutate()}
              >
                {state() === "paused" ? (
                  <IconCapPlayCircle />
                ) : (
                  <IconCapPauseCircle />
                )}
              </ActionButton>
            )}

            <ActionButton
              disabled={restartRecording.isPending}
              onClick={() => restartRecording.mutate()}
            >
              <IconCapRestart />
            </ActionButton>
            <ActionButton
              disabled={deleteRecording.isPending}
              onClick={() => deleteRecording.mutate()}
            >
              <IconCapTrash />
            </ActionButton>
          </Show>
        </div>
      </div>
      <Show when={state() !== "countdown"}>
        <div
          class="non-styled-move cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-5 hover:cursor-move"
          data-tauri-drag-region
        >
          <IconCapMoreVertical class="pointer-events-none text-gray-10" />
        </div>
      </Show>
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

  events.audioInputLevelChange.listen((dbs) => {
    const DB_MIN = -60;
    const DB_MAX = 0;

    const dbValue = dbs.payload ?? DB_MIN;
    const normalizedLevel = Math.max(
      0,
      Math.min(1, (dbValue - DB_MIN) / (DB_MAX - DB_MIN))
    );
    setLevel(normalizedLevel);
  });

  return level;
}
