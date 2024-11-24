import { createEffect, createSignal, type ComponentProps } from "solid-js";
import { cx } from "cva";

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
    <div class="flex flex-row items-stretch bg-gray-500 dark:bg-gray-50 w-full h-full animate-in fade-in">
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
      <div
        class="bg-gray-500 dark:bg-gray-50 cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-400 dark:border-gray-200"
        data-tauri-drag-region
      >
        <IconCapMoreVertical
          class="text-gray-400 dark:text-gray-400"
          data-tauri-drag-region
        />
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
        "text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-300",
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
