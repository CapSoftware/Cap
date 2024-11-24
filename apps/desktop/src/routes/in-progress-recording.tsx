import { createEffect, createSignal, type ComponentProps } from "solid-js";

import { commands, events } from "~/utils/tauri";
import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";

export default function () {
  const start = Date.now();
  const [time, setTime] = createSignal(Date.now());
  const [isPaused, setIsPaused] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);

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
    <div
      class="text-[--text-primary] flex flex-row items-stretch bg-gray-50 dark:bg-gray-100 w-full h-full animate-in fade-in"
    >
      <div class="flex flex-row justify-between p-[0.25rem] flex-1">
        <button
          disabled={stopRecording.isPending}
          class="py-[0.25rem] px-[0.5rem] text-red-300 dark:text-red-300 gap-[0.25rem] flex flex-row items-center hover:bg-red-transparent-20 transition-colors rounded-lg"
          type="button"
          onClick={() => stopRecording.mutate()}
        >
          <IconCapStopCircle />
          <span class="font-[500] text-[0.875rem]">
            {formatTime((time() - start) / 1000)}
          </span>
        </button>

        {window.FLAGS.pauseResume && (
          <ActionButton
            disabled={togglePause.isPending}
            onClick={() => togglePause.mutate()}
            class="text-[--text-primary] hover:bg-gray-200 dark:hover:bg-gray-300 flex items-center justify-center"
          >
            {isPaused() ? <IconCapPlayCircle /> : <IconCapPauseCircle />}
          </ActionButton>
        )}

        <ActionButton
          disabled={restartRecording.isPending}
          onClick={() => restartRecording.mutate()}
          class="text-[--text-primary] hover:bg-gray-200 dark:hover:bg-gray-300 h-8 w-8 flex items-center justify-center"
        >
          <IconCapRestart class="dark:fill-white dark:hover:fill-white" />
        </ActionButton>
      </div>
      <div
        class="bg-white-transparent-5 cursor-move flex items-center justify-center p-[0.25rem] border-l border-white-transparent-5"
        data-tauri-drag-region
      >
        <IconCapMoreVertical data-tauri-drag-region />
      </div>
    </div>
  );
}

function ActionButton(props: ComponentProps<"button">) {
  return (
    <button
      {...props}
      class="p-[0.25rem] enabled:hover:bg-white-transparent-5 enabled:hover:text-gray-50 rounded-lg transition-colors"
      type="button"
    />
  );
}

function formatTime(secs: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
