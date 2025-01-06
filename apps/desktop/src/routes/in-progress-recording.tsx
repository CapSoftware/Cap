import { createEffect, createSignal, type ComponentProps } from "solid-js";
import { cx } from "cva";

import { commands, events } from "~/utils/tauri";
import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";
import {
  createOptionsQuery,
  createCurrentRecordingQuery,
} from "~/utils/queries";

const audioLevelStore = {
  level: 0,
  initialized: false,
  init() {
    if (this.initialized) return;

    events.audioInputLevelChange.listen((dbs) => {
      const DB_MIN = -60;
      const DB_MAX = 0;

      const dbValue = dbs.payload ?? DB_MIN;
      const normalizedLevel = Math.max(
        0,
        Math.min(1, (dbValue - DB_MIN) / (DB_MAX - DB_MIN))
      );
      this.level = normalizedLevel;

      window.dispatchEvent(
        new CustomEvent("audioLevelChange", { detail: normalizedLevel })
      );
    });

    this.initialized = true;
  },
  cleanup() {
    this.initialized = false;
    this.level = 0;
  },
};

export default function () {
  const start = Date.now();
  const [time, setTime] = createSignal(Date.now());
  const [isPaused, setIsPaused] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const [audioLevel, setAudioLevel] = createSignal<number>(0);
  const currentRecording = createCurrentRecordingQuery();
  const { options } = createOptionsQuery();

  const isAudioEnabled = () => {
    return options.data?.audioInputName != null;
  };

  createTimer(
    () => {
      if (stopped() || isPaused()) return;
      setTime(Date.now());
    },
    100,
    setInterval
  );

  createEffect(() => {
    setTime(Date.now());
  });

  // Single effect to handle audio initialization and cleanup
  createEffect(() => {
    if (!isAudioEnabled()) {
      audioLevelStore.cleanup();
      setAudioLevel(0);
      return;
    }

    audioLevelStore.init();
    setAudioLevel(audioLevelStore.level);

    const handler = (e: CustomEvent) => {
      setAudioLevel(e.detail);
    };

    window.addEventListener("audioLevelChange", handler as EventListener);
    return () => {
      window.removeEventListener("audioLevelChange", handler as EventListener);
    };
  });

  const stopRecording = createMutation(() => ({
    mutationFn: async () => {
      setStopped(true);
      await commands.stopRecording();
    },
  }));

  const togglePause = createMutation(() => ({
    mutationFn: async () => {
      if (isPaused()) {
        await commands.resumeRecording();
        setIsPaused(false);
      } else {
        await commands.pauseRecording();
        setIsPaused(true);
      }
    },
  }));

  const restartRecording = createMutation(() => ({
    mutationFn: async () => {
      await events.requestRestartRecording.emit();
      setStopped(false);
      setIsPaused(false);
      setTime(Date.now());
    },
  }));

  return (
    <div class="flex flex-row items-stretch bg-gray-500 dark:bg-gray-50 w-full h-full animate-in fade-in">
      <div class="flex flex-row justify-between p-[0.25rem] flex-1">
        <button
          disabled={stopRecording.isPending}
          class="py-[0.25rem] px-[0.5rem] text-red-300 dark:text-red-300 gap-[0.25rem] flex flex-row items-center rounded-lg"
          type="button"
          onClick={() => stopRecording.mutate()}
        >
          <IconCapStopCircle />
          <span class="font-[500] text-[0.875rem]">
            {formatTime((time() - start) / 1000)}
          </span>
        </button>

        <div class="flex items-center gap-1">
          <div class="relative h-8 w-8 flex items-center justify-center">
            {isAudioEnabled() ? (
              <>
                <IconCapMicrophone class="size-5 text-gray-400" />
                <div class="absolute bottom-1 left-1 right-1 h-0.5 bg-gray-400 overflow-hidden rounded-full">
                  <div
                    class="absolute inset-0 bg-blue-400 transition-transform duration-100"
                    style={{
                      transform: `translateX(-${(1 - audioLevel()) * 100}%)`,
                    }}
                  />
                </div>
              </>
            ) : (
              <IconLucideMicOff
                class="size-5 text-gray-300 opacity-20 dark:text-gray-300 dark:opacity-100"
                data-tauri-drag-region
              />
            )}
          </div>

          {window.FLAGS.pauseResume && (
            <ActionButton
              disabled={togglePause.isPending}
              onClick={() => togglePause.mutate()}
            >
              {isPaused() ? <IconCapPlayCircle /> : <IconCapPauseCircle />}
            </ActionButton>
          )}

          <ActionButton
            disabled={restartRecording.isPending}
            onClick={() => restartRecording.mutate()}
          >
            <IconCapRestart />
          </ActionButton>
        </div>
      </div>
      <div
        class="non-styled-move cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-400 dark:border-gray-200 hover:cursor-move"
        data-tauri-drag-region
      >
        <IconCapMoreVertical class="pointer-events-none text-gray-400 dark:text-gray-400" />
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
        "text-gray-400",
        "h-8 w-8 flex items-center justify-center",
        props.class
      )}
      type="button"
    />
  );
}

function formatTime(secs: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
