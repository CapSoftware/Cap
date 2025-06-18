import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, createSignal, type ComponentProps } from "solid-js";
import { createStore, produce } from "solid-js/store";

import {
  createCurrentRecordingQuery,
  createOptionsQuery,
} from "~/utils/queries";
import { commands, events } from "~/utils/tauri";

type State = "recording" | "paused" | "stopped";

export default function () {
  const start = Date.now();
  const [time, setTime] = createSignal(Date.now());
  const [state, setState] = createSignal<State>("recording");
  const currentRecording = createCurrentRecordingQuery();
  const { rawOptions } = createOptionsQuery();

  const audioLevel = createAudioInputLevel();

  const [pauseResumes, setPauseResumes] = createStore<
    | []
    | [
        ...Array<{ pause: number; resume?: number }>,
        { pause: number; resume?: number }
      ]
  >([]);

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

      await events.requestRestartRecording.emit();
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

      await events.requestDeleteRecording.emit();
      setState("stopped");
    },
  }));

  const adjustedTime = () => {
    let t = time() - start;
    for (const { pause, resume } of pauseResumes) {
      if (pause && resume) t -= resume - pause;
    }
    return t;
  };

  return (
    <div class="flex flex-row items-stretch w-full h-full bg-gray-1 animate-in fade-in">
      <div class="flex flex-row justify-between p-[0.25rem] flex-1">
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

        <div class="flex gap-1 items-center">
          <div class="flex relative justify-center items-center w-8 h-8">
            {rawOptions.micName != null ? (
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
        </div>
      </div>
      <div
        class="non-styled-move cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-5 hover:cursor-move"
        data-tauri-drag-region
      >
        <IconCapMoreVertical class="pointer-events-none text-gray-10" />
      </div>
    </div>
  );
}

function ActionButton(props: ComponentProps<"button">) {
  return (
    <button
      {...props}
      class={cx(
        "p-[0.25rem] rounded-lg transition-colors",
        "text-gray-11",
        "h-8 w-8 flex items-center justify-center",
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
